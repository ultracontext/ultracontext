# CONTRACT — the v2 core op contract

The spec the Rust core is built against. Source of truth for behavior: the v1
contract extracted from tag `v1-final` (160 core tests, 134 op tests) into
`contract/v1-extraction.json` — exact inputs, outputs, error codes, and
test-pinned behaviors per op. This document records the v2 DECISIONS on top.

Built piece by piece: **a. ops inventory** (this section) · b. data model
(`MODEL.md`) · c. errors · d. search · e. list/metadata · f. fixture suite.

## a. Ops inventory — KEPT / DROPPED / NEW

### Context ops (public surface)

| v1 op | v2 | Notes |
|---|---|---|
| `create-context` | **KEPT** | Create root + fork in one op: `{from, version, at, before, metadata}`. Validation order is load-bearing (timestamp parse → require-from → source lookup → head selection → at-range). |
| `append-messages` | **KEPT** | One call with an array = ONE version bump. Free-form message content + optional per-message metadata. |
| `get-context` | **KEPT** | Single read with time-travel selectors `{version, at, before, history}` → `{data, version, versions?}`. |
| `get-context-messages` | **ABSORBED** | v1's option-less internal read (latest head, null on missing). Becomes an internal helper in v2, not a public op — `get` covers it. |
| `update-messages` | **KEPT** | Copy-on-write → new version. Patch by `id` XOR `index` (negative indices ok), batch or single, version metadata via options. |
| `delete-messages` | **KEPT** | Soft delete = new version without the messages; recoverable via time-travel. Mixed ids/indexes. Empty ids refused loudly. |
| `delete-context` | **KEPT** | Permanent context delete. Requires explicit `{permanent: true}` — destruction never implicit. Audit metadata echoed back. |
| `delete-many` | **KEPT** | Batch permanent, max 100, per-item results `{results, deleted_count}` — partial success first-class, never throws. Forks of deleted roots survive (parent_id cleared). |
| `list-contexts` | **KEPT (changed)** | Roots only, newest first, default limit 20. Filter model redesigned in piece e (v1's five blessed metadata keys → generic). |
| — | **NEW: `search`** | FTS5 full-text over messages. Spec in piece d. |

### Dropped with their feature (out of 2.0, return additively)

| v1 op | Why |
|---|---|
| `create-key`, `verify-key` | api_keys/projects = hosted infra. Local core has no tenancy: single implicit project. |
| `events/*` (emit, envelope, ops) | Events primitive returns with mirror/agent-sync. |

### SDK surface decisions carried into v2 (from v1 `ultracontext.ts` + `client.py`)

- **Flat class, 6 verbs**: `create` · `append` · `get` · `update` · `delete` · `deleteMany`/`delete_many`. No namespaces. Sync constructor, lazy IO.
- **Overloads kept**: `get()` = list, `get(id)` = single · `delete(id, ids)` = soft, `delete(id, {permanent: true})` = hard.
- **Mode rule**: `mode ?? (apiKey ? 'remote' : 'local')` — explicit mode wins. (Remote itself is out of 2.0; the rule and the config shape stay so it lands additively.)
- **Three metadata channels**: context metadata (create) · version metadata (update / soft delete) · audit metadata (permanent delete, echoed).
- **Safety rails**: empty-ids delete refused with a loud message; `permanent` + ids mutually exclusive; validated before any IO, identically in both languages.
- **v2 erases the v1 Python local-mode gaps** (subprocess limitations die with in-process core): batch update, non-content field updates, structured local metadata, full list filters, true batch delete_many.

### Cross-cutting primitives (detail in `contract/v1-extraction.json`)

- **Result**: every op returns `Result<T>` — `ok(data)` | `err(code, message)`. Codes: `not_found` · `invalid_input` · `internal` (HTTP map 404/400/500). Full message vocabulary ported verbatim (piece c).
- **Public ids**: `ctx_` / `msg_` + 24 lowercase hex chars (12 crypto-random bytes).
- **Timestamps**: ISO-8601 UTC ms precision (`YYYY-MM-DDTHH:mm:ss.sssZ`), normalization never throws, unparseable values pass through verbatim.
- **MessageView**: `{...content, id, index, metadata}` — content spread first (generated keys win); row internals (`prev_id`, `parent_id`, `context_id`, `type`, `project_id`) never exposed.
