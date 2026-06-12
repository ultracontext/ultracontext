# CONTRACT — the v2 core op contract

The spec the Rust core is built against. Source of truth for behavior: the v1
contract extracted from tag `v1-final` (235 core tests; 160 in `src/ops`, 134
covering the nine extracted context ops) into `contract/v1-extraction.json` —
exact inputs, outputs, error codes, and test-pinned behaviors per op. This
document records the v2 DECISIONS on top.

Built piece by piece: **a. ops inventory** · b. data model (`MODEL.md`) ·
**c. errors** · **d. search** · **e. list/metadata** · **f. fixtures** ·
**g. artifacts**.

## a. Ops inventory — KEPT / DROPPED / NEW

### Context ops (public surface)

| v1 op | v2 | Notes |
|---|---|---|
| `create-context` (plain) | **KEPT → `create`** | `create({metadata?})` — just a new root + create head. The fork half moves out (below); the v1 cross-field rule `'version, at, and before require from'` dies with the split. |
| `create-context` (fork) | **SPLIT → `fork`** | `fork(sourceId, {version?, at?, before?, metadata?})` — new root (`parent_id` → source root), chosen version's messages copied with provenance. Same core mechanics, own verb: intent is obvious, params are always valid. Validation order stays load-bearing (timestamp parse → source lookup → head selection → at-range). |
| — | **`checkpoint` — NOT in 2.0** | `checkpoint(id, {metadata?})` → `{version}` would cut a version NOW (the mechanism v1 hid behind empty updates). Never explicitly approved nor rejected — parked in Deferred; `operation` is typed open, so adding it later is a free minor. |
| `append-messages` | **KEPT** | Appends to the CURRENT version — no version bump (versions mark edits, not the stream; a thousand appends ≠ a thousand versions). Array = one atomic extension. Free-form content + optional per-message metadata. Time-travel within the stream via get's `{at}`/`{before}`. |
| `get-context` | **KEPT (extended)** | Single read with time-travel selectors `{version, at, before, history}` → `{data, version, versions?}`. NEW in v2 (agent-first): **windowed reads** — `{last: n}` / `{range: [i, j]}` slice the message list, envelope always carries `total`; truncation is announced in-band (agents miss structured-only signals). `{message: msgId}` fetches ONE message's full content — the escape hatch for search snippets. Full get stays the no-options default. |
| `get-context-messages` | **ABSORBED** | v1's option-less internal read (latest head, null on missing). Becomes an internal helper in v2, not a public op — `get` covers it. |
| `update-messages` | **KEPT (extended)** | Copy-on-write → new version. Patch by `id` XOR `index` (negative indices ok), batch or single, version metadata via options. NEW in v2: `update(id, {metadata})` with no patches = **context metadata update** — shallow merge onto the root's mutable label, `null` deletes a key, NO version bump (content is versioned; labels are not). |
| `delete-messages` | **KEPT** | Soft delete = new version without the messages; recoverable via time-travel. Mixed ids/indexes. Empty ids refused loudly. |
| `delete-context` | **KEPT (changed)** | Permanent context delete. Requires explicit `{permanent: true}` — destruction never implicit. v2 DELETES the v1 audit-metadata echo: it stored nothing and echoed once — a false affordance teaching agents an audit record exists. Real audit = the caller's own journal. |
| `delete-many` | **DROPPED** | It was a transport optimization (HTTP round-trips on the hosted API), not a primitive — same reason `updateMany` never existed. In-process, a loop costs the same. Returns at the transport layer if/when hosted does. |
| `list-contexts` | **KEPT (changed)** | Roots only, newest first, default limit 20. Filter model redesigned in piece e (v1's five blessed metadata keys → generic). |
| — | **NEW: `search`** | FTS5 full-text over messages. Spec in piece d. |
| — | **NEW: `save` / `load`** | Artifacts — objects attached to a context (drafts, files, images, audio). Spec in piece g. |

### Dropped with their feature (out of 2.0, return additively)

| v1 op | Why |
|---|---|
| `create-key`, `verify-key` | api_keys/projects = hosted infra. Local core has no tenancy: single implicit project. |
| `events/*` (emit, envelope, ops) | Events primitive returns with mirror/agent-sync. |

### SDK surface decisions carried into v2 (from v1 `ultracontext.ts` + `client.py`)

- **Flat class, 9 verbs**: `create` · `fork` · `get` · `append` · `update` · `delete` · `search` · `save` · `load`. No namespaces. Sync constructor, lazy IO.
- **Overloads kept**: `get()` = list, `get(id)` = single · `delete(id, ids)` = soft, `delete(id, {permanent: true})` = hard.
- **Mode rule**: `mode ?? (apiKey ? 'remote' : 'local')` — explicit mode wins. (Remote itself is out of 2.0; the rule and the config shape stay so it lands additively.)
- **Two metadata channels**: context label (mutable) · version note (immutable) — full picture in piece e. (v1's third channel, the audit echo, is deleted in v2.)
- **Safety rails**: empty-ids delete refused with a loud message (identical in both v1 SDKs); `permanent` + ids mutually exclusive — in v1 this check was Python-ONLY (JS had no runtime guard); v2 makes it identical in both languages, validated before any IO.
- **v2 erases the v1 Python local-mode gaps** (subprocess limitations die with in-process core): batch update, non-content field updates, structured local metadata, full list filters, true batch delete_many.

### Cross-cutting primitives (detail in `contract/v1-extraction.json`)

- **Result**: every op returns `Result<T>` — `ok(data)` | `err(code, message)`.
- **Public ids**: `ctx_` / `msg_` / `art_` + 24 lowercase hex chars (12 crypto-random bytes). **Message ids are STABLE across edits** (v2 decision, diverges from v1): copy-on-write copies preserve the original id for untouched messages — uniqueness is `(head, id)` internally. A patched message gets a NEW id (new content = new identity; `parent_id` → original); a deleted one's id dies with it. Same id across versions ⇒ same logical message, same content. Stale-id semantics: reads resolve via lineage (response carries `supersedes` when it happens); writes targeting a stale id error with lineage info — silent write-resolution would mask concurrent edits.
- **Timestamps**: ISO-8601 UTC ms precision (`YYYY-MM-DDTHH:mm:ss.sssZ`), normalization never throws, unparseable values pass through verbatim. (Unix time rejected: the db file must be human-readable — Transparency — and sec-vs-ms is a cross-language footgun.)
- **MessageView**: `{...content, id, index, metadata, created_at}` — content spread first (generated keys win); row internals (`prev_id`, `parent_id`, `context_id`, `type`, rowids) never exposed. `created_at` is engine-issued — the one clock all writers share (multi-agent audit needs the when). It must ship at freeze: adding a generated key LATER would shadow user content keys (breaking).

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

- **Surface**: `search(query, {limit = 20, context_id?, metadata?})` →
  `{data: [...]}`. Message hits: `{snippet, id, index, metadata, created_at,
  context_id}`. Artifact hits: `{snippet, id, name, kind, created_at,
  context_id}` — no `index` (meaningless for an artifact); the `art_`/`msg_`
  id prefix tells the kinds apart. Hits carry a **snippet** (FTS5
  `snippet()`, match highlighted), NOT full content: search is the agent's
  recall op and 20 full multi-thousand-token messages is a context-window
  bomb. Full content is one targeted call away: `get(context_id, {message:
  id})` / `load(context_id, id)`. `metadata` narrows hits (same generic
  equality as list filters). Ordered by relevance (bm25). No score field in
  2.0 (additive later).
- **What is indexed**: all string values of message `content` (walked
  recursively), space-joined — plus current TEXT artifact versions (piece g).
  Content only — metadata is for filters, search is for what was said.
  CURRENT versions only: the index mirrors present state; superseded copies
  leave the index when a new head lands (no duplicate hits across versions).
  History search = additive later.
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
- **The two metadata channels** (complete picture):

| Channel | Lives on | Mutable? | Set via | Read via |
|---|---|---|---|---|
| Context label | root | YES — shallow merge, `null` deletes | `create` · `update(id, {metadata})` | `list` rows, no version bump |
| Version note | head | no — immutable commit message | options on `update`/`delete` | `get(id, {history: true})` |

(v1 had a third channel — audit metadata echoed by permanent delete — deleted
in v2: it persisted nothing and taught agents a record existed.)

- **Per-message metadata**: set at `append`, carried through copies verbatim,
  returned in every MessageView. **Filterable** (v2 decision): the same
  generic equality shape as list filters — `get(id, {metadata: {type:
  'tool_use'}})` slices the current list; `search(q, {metadata: {...}})`
  narrows hits. AND across keys, scalar values, top-level keys.

## g. Artifacts

Objects attached to a context — drafts, generated files, images, audio.
Usually LLM-generated, regenerated over time. A fourth node kind, same table,
same two pointers — the existing pattern a third time:

- **Schema**: `type='artifact'` · `context_id` → the context ROOT (ownership;
  ON DELETE CASCADE — scrubbing a context scrubs its artifacts, no-orphans
  for free) · `prev_id` → the previous version of the SAME artifact (its own
  version chain; CURRENT = the unpointed node, the existing head rule) ·
  `parent_id` → provenance (source version on fork) · content =
  `{name, kind, size}` + text data as a plain string · binary bytes in a
  nullable `data BLOB` column — **in the schema from day 1** (column later =
  migration), no base64, one SQLite file = all your data.
- **`save(ctxId, {name, kind?, data, metadata?})`** → `{id, version}` —
  upsert by `name` (unique per context): same name = new version of that
  artifact, new name = new artifact. Artifacts have their OWN version clock —
  regenerating a draft 50× bumps zero context versions, and context
  copy-on-write never touches artifact nodes (blobs are never copied).
- **`load(ctxId)`** → list `[{id, name, kind, size, version, created_at}]` —
  metadata only, NO bytes (context-window friendly). `load(ctxId, nameOrId)`
  → the current version with data. `{version: n}` time-travels an artifact.
- **Delete**: an artifact id works in the existing verb —
  `delete(artId, {permanent: true})` scrubs the artifact's chain. Explicit,
  like everything destructive.
- **Fork**: copies each artifact's CURRENT version into the new context
  (`parent_id` → source version). History stays with the source — mirrors
  fork copying only the chosen version's messages.
- **Search**: current TEXT artifact versions are FTS-indexed; hits carry
  `{artifact: name, kind, context_id}` — "where did I write about X" finds
  the draft.
- **Standalone artifacts**: a usage pattern, not a flavor — create a library
  context once (`create({metadata: {name: 'assets'}})`) and `save` into it.
  Every artifact has exactly one owner; the scrub story stays uniform.
- **Out of 2.0** (additive later): `{ref: path}` for huge external files,
  content-hash dedupe, history pruning.

## f. Fixtures — parity as data

Contract tests are DATA, not code: JSON cases in `fixtures/` (repo root),
consumed by THREE runners — `cargo test` (core), `node:test` (built JS SDK),
`pytest` (built wheel). Same input → same shape, code, and message in every
layer, on every commit. "Identical surface" enforced mechanically.

Case shape:

```json
{
    "name": "append to missing context",
    "setup": [],
    "op": "append",
    "input": { "id": "ctx_000000000000000000000000", "messages": [{ "text": "oi" }] },
    "expect": { "error": { "code": "not_found", "message": "Context not found" } }
}
```

- **`setup`**: ops run in order on a fresh temp db before the case's `op`.
- **References**: a string starting `$setup[n]` resolves into the n-th setup
  result — `"$setup[0].id"`, `"$setup[1].data[2].created_at"`. How
  time-travel cases capture engine-generated ids/timestamps.
- **Matchers** (exactly three): `"$any"` (present, any value) ·
  `"$re:<regex>"` (e.g. `"$re:^msg_[0-9a-f]{24}$"`) · `"$len:<n>"` (array
  length). Everything else = deep equality. Error cases match `code` AND
  `message` exactly.
- **Runner contract**: fresh db per case · run setup · run op · assert
  `expect` against the result. Thin by design — all intelligence lives in
  the fixture files.

## Patterns, not API

Real needs deliberately served by composition instead of surface:

- **Subagents / nested contexts**: the inner context is a REAL context
  (`create`/`fork`); the parent holds a small ref message `{context: id,
  summary}` — collapsed by nature, searchable by summary, expanded only by
  an explicit `get(innerId)`. No nesting in the schema (cascade blast radius
  + cycle risk for near-zero gain).
- **Tool use**: NOT a node kind — provider payload shapes churn (Anthropic ≠
  OpenAI ≠ Gemini) and carry no new mechanics. Tool calls are message
  content; distinguish via per-message metadata convention (`{type:
  'tool_use'}`), filterable on get/search.
- **Standalone artifacts**: a library context you `save` into (piece g).
- **Keyed slots** (named replaceable message): considered and KILLED — a
  payload-dependent verb semantics violates "append never bumps"; the need
  is covered by caching the draft's id + `update`, or by artifacts.

## Deferred — agreed, additive, not in 2.0

Decisions already made whose surface lands in any 2.x minor without breakage:
token counting (`chars` + `tokens_estimate` on envelopes; `tokenizer` SDK
option for exact counts — note: exact local counting is impossible for
Claude/Gemini anyway, tokenizers are private) · stats (`message_count`,
`updated_at`, `version` on list rows; `stat` read) · delta reads
(`{since: msgId}`) · concurrency preconditions (`ifVersion`/`ifLast`,
`conflict` code, idempotency key — ships with remote mode where the retry
window is real) · compaction/splice (range-replace as one head) ·
`forked_from` exposure + list filter · artifact `{ref}`/dedupe/pruning ·
`AsyncUltraContext` (Python async twin — sync ships first; async is an
additive class) · structural sharing for edits (membership lists —
engine-internal swap, API-invisible).

Parked, UNDECIDED (not agreed — just not blocking, because adding later is
free): `checkpoint` verb. `operation` is typed as an OPEN string in every
SDK, so a future decision is never breaking either way.
