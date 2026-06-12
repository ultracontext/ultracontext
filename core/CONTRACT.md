# CONTRACT — the v2 core op contract

The spec the Rust core is built against. Source of truth for behavior: the v1
contract extracted from tag `v1-final` (160 core tests, 134 op tests) into
`contract/v1-extraction.json` — exact inputs, outputs, error codes, and
test-pinned behaviors per op. This document records the v2 DECISIONS on top.

Built piece by piece: **a. ops inventory** · b. data model (`MODEL.md`) ·
**c. errors** · **d. search** · **e. list/metadata** · f. fixture suite (pending).

## a. Ops inventory — KEPT / DROPPED / NEW

### Context ops (public surface)

| v1 op | v2 | Notes |
|---|---|---|
| `create-context` (plain) | **KEPT → `create`** | `create({metadata?})` — just a new root + create head. The fork half moves out (below); the v1 cross-field rule `'version, at, and before require from'` dies with the split. |
| `create-context` (fork) | **SPLIT → `fork`** | `fork(sourceId, {version?, at?, before?, metadata?})` — new root (`parent_id` → source root), chosen version's messages copied with provenance. Same core mechanics, own verb: intent is obvious, params are always valid. Validation order stays load-bearing (timestamp parse → source lookup → head selection → at-range). |
| — | **NEW: `checkpoint`** | `checkpoint(id, {metadata?})` → `{version}`. Cuts a version NOW: new head `{operation: 'checkpoint', affected: []}` + version metadata. Names the mechanism v1 hid behind empty updates ("update with no patches creates a head"). The deliberate commit: append = stream, checkpoint = "this moment is history-worthy". |
| `append-messages` | **KEPT** | Appends to the CURRENT version — no version bump (versions mark edits, not the stream; a thousand appends ≠ a thousand versions). Array = one atomic extension. Free-form content + optional per-message metadata. Time-travel within the stream via get's `{at}`/`{before}`. |
| `get-context` | **KEPT** | Single read with time-travel selectors `{version, at, before, history}` → `{data, version, versions?}`. |
| `get-context-messages` | **ABSORBED** | v1's option-less internal read (latest head, null on missing). Becomes an internal helper in v2, not a public op — `get` covers it. |
| `update-messages` | **KEPT (extended)** | Copy-on-write → new version. Patch by `id` XOR `index` (negative indices ok), batch or single, version metadata via options. NEW in v2: `update(id, {metadata})` with no patches = **context metadata update** — shallow merge onto the root's mutable label, `null` deletes a key, NO version bump (content is versioned; labels are not). |
| `delete-messages` | **KEPT** | Soft delete = new version without the messages; recoverable via time-travel. Mixed ids/indexes. Empty ids refused loudly. |
| `delete-context` | **KEPT** | Permanent context delete. Requires explicit `{permanent: true}` — destruction never implicit. Audit metadata echoed back. |
| `delete-many` | **DROPPED** | It was a transport optimization (HTTP round-trips on the hosted API), not a primitive — same reason `updateMany` never existed. In-process, a loop costs the same. Returns at the transport layer if/when hosted does. |
| `list-contexts` | **KEPT (changed)** | Roots only, newest first, default limit 20. Filter model redesigned in piece e (v1's five blessed metadata keys → generic). |
| — | **NEW: `search`** | FTS5 full-text over messages. Spec in piece d. |

### Dropped with their feature (out of 2.0, return additively)

| v1 op | Why |
|---|---|
| `create-key`, `verify-key` | api_keys/projects = hosted infra. Local core has no tenancy: single implicit project. |
| `events/*` (emit, envelope, ops) | Events primitive returns with mirror/agent-sync. |

### SDK surface decisions carried into v2 (from v1 `ultracontext.ts` + `client.py`)

- **Flat class, 7 verbs**: `create` · `fork` · `checkpoint` · `get` · `append` · `update` · `delete` (+ `search`). No namespaces. Sync constructor, lazy IO.
- **Overloads kept**: `get()` = list, `get(id)` = single · `delete(id, ids)` = soft, `delete(id, {permanent: true})` = hard.
- **Mode rule**: `mode ?? (apiKey ? 'remote' : 'local')` — explicit mode wins. (Remote itself is out of 2.0; the rule and the config shape stay so it lands additively.)
- **Three metadata channels**: context metadata (create) · version metadata (update / soft delete) · audit metadata (permanent delete, echoed).
- **Safety rails**: empty-ids delete refused with a loud message; `permanent` + ids mutually exclusive; validated before any IO, identically in both languages.
- **v2 erases the v1 Python local-mode gaps** (subprocess limitations die with in-process core): batch update, non-content field updates, structured local metadata, full list filters, true batch delete_many.

### Cross-cutting primitives (detail in `contract/v1-extraction.json`)

- **Result**: every op returns `Result<T>` — `ok(data)` | `err(code, message)`.
- **Public ids**: `ctx_` / `msg_` + 24 lowercase hex chars (12 crypto-random bytes). Message ids are stable WITHIN a version, not across edits: update/delete/checkpoint re-issue copies with fresh ids (`parent_id` → original). Hold ids from your latest `get`/`append`.
- **Timestamps**: ISO-8601 UTC ms precision (`YYYY-MM-DDTHH:mm:ss.sssZ`), normalization never throws, unparseable values pass through verbatim. (Unix time rejected: the db file must be human-readable — Transparency — and sec-vs-ms is a cross-language footgun.)
- **MessageView**: `{...content, id, index, metadata}` — content spread first (generated keys win); row internals (`prev_id`, `parent_id`, `context_id`, `type`, `project_id`) never exposed.

## c. Errors

One envelope, one vocabulary, every language.

**Codes** (complete list — adding one is a contract change):

| Code | HTTP map | When |
|---|---|---|
| `not_found` | 404 | context/version/message doesn't resolve |
| `invalid_input` | 400 | bad params — caught before any write |
| `busy` | 503 | db locked past `busy_timeout` (another process holds it) — NEW in v2 |
| `incompatible_db` | — | file at the db path has a foreign/v1 schema or unknown `user_version` — NEW in v2 |
| `internal` | 500 | invariant broken (e.g. head missing for an existing root) |

**Envelope across the FFI boundary**: core returns `UcError { code, message }`.
JS throws `UltraContextError` with `.code`; Python raises `UltraContextError`
with `.code`. Same code AND same message string for the same failure in both
languages — pinned by the fixture suite (piece f).

**Message vocabulary**: ported verbatim from v1 for kept ops (exact strings in
`contract/v1-extraction.json` — e.g. `'Context not found'`,
`'Message not found: ${id}'`, `'Invalid timestamp format'`,
`'Cannot specify both id and index'`, `'Index out of range: ${index}'`).
Key/event/deleteMany messages die with their ops. The v1 cross-field error
`'version, at, and before require from'` dies with the create/fork split.

**Deliberate v2 fixes** (divergences from v1, on purpose):

- Reserved head-metadata keys `operation`/`affected` can no longer be
  clobbered by user version-metadata (v1 spread user keys last; v2 reserves).
- Every op runs in a real transaction (v1's create used manual compensating
  rollback).

## d. Search

The new op. FTS5 finds, bm25 orders.

- **Surface**: `search(query, {limit = 20, context_id?})` →
  `{data: [{...content, id, index, metadata, context_id}]}` — each hit has
  the exact shape of a `get` message plus `context_id` saying where it lives.
  Ordered by relevance (bm25). No score field in 2.0 (additive later).
- **What is indexed**: all string values of message `content` (walked
  recursively), space-joined. Content only — metadata is for `list` filters,
  search is for what was said. CURRENT versions only: the index mirrors
  present state; superseded copies leave the index when a new head lands
  (no duplicate hits across versions). History search = additive later.
- **Index mechanics**: FTS5 external-content table over message nodes,
  maintained inside the same transaction as the write — search works with
  zero index calls, always in sync ("just works").
- **Tokenizer**: `unicode61 remove_diacritics 2` — accent-insensitive
  (busca "relatorio", acha "relatório"). Hardcoded great default; becomes
  configurable if real usage demands (lego, later).
- **Query safety**: user input is treated as TERMS, never raw MATCH syntax —
  tokens are quoted and AND-joined. `"foo -bar"` can never throw a syntax
  error. `invalid_input` only for an empty query.

## e. List & metadata

- **Surface**: `list({limit = 20, metadata?, after?, before?})` →
  `{data: [{id, metadata, created_at}]}` (SDK: the `get()` no-arg overload).
- **Filters**: v1's five blessed keys (`source/user_id/host/project_path/
  session_id`) die — agent-capture relics. Replaced by generic equality:
  `metadata: {user_id: 'u1', archived: false}` = AND across keys, scalar
  values (string/number/bool), top-level keys in 2.0. `after`/`before` =
  strict created_at bounds. No offset pagination; the envelope has room for
  an additive cursor.
- **Ordering**: `created_at` DESC (newest first), pinned.
- **The three metadata channels** (complete picture):

| Channel | Lives on | Mutable? | Set via | Read via |
|---|---|---|---|---|
| Context label | root | YES — shallow merge, `null` deletes | `create` · `update(id, {metadata})` | `list` rows, no version bump |
| Version note | head | no — immutable commit message | options on `update`/`delete`/`checkpoint` | `get(id, {history: true})` |
| Audit echo | nowhere (returned only) | — | `delete(id, {permanent: true, metadata})` | the response, once |

- **Per-message metadata**: set at `append`, carried through copies verbatim,
  returned in every MessageView. Not filterable in 2.0.
