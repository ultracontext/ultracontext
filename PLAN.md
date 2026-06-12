# PLAN — 2.0 implementation

The approval artifact. Everything below gets built EXACTLY as written, each
phase as a Workflow, with a review gate between phases. Edit freely; nothing
runs without explicit go. Deleted once 2.0 ships.

Contract = `core/CONTRACT.md` · model = `core/MODEL.md` (sources of truth;
this file is HOW, those are WHAT).

## Status

- DONE: contract (pieces a–g) · skeleton (workspace, empty core crate,
  fixtures/, sdks/ stubs, ci.yml)
- BLOCKED: local builds need `sudo xcodebuild -license accept` (one-time)
- Gate 0 (this plan) → Fase 3 → gate → Fase 4 → gate → Fase 5 → gate → Fase 6

## One new technical decision (needs your eye)

**Internal pointers use rowids, not public ids.** Consequence of ids-B
(copies preserve `public_id` → message public_ids are NOT globally unique →
SQLite foreign keys can't reference them). So: `prev` / `parent` / `owner`
are INTEGER references to `nodes.id` (rowid — always unique), which is what
makes ON DELETE CASCADE / SET NULL work. Public ids stay the ONLY thing the
API ever shows; rowids never leak. Same model, sound FKs.

Name map (MODEL.md concept → physical column): `type` → `kind` ·
`prev_id` → `prev` · `parent_id` → `parent` · `context_id` → `owner`.

## Schema (draft DDL — finalized by the first RED tests)

```sql
PRAGMA user_version = 1;          -- stamped at create; foreign/v1 file → incompatible_db

CREATE TABLE nodes (
    id         INTEGER PRIMARY KEY,
    public_id  TEXT    NOT NULL,                 -- ctx_/msg_/art_ + 24 hex
    kind       TEXT    NOT NULL CHECK (kind IN ('context','message','artifact')),
    content    TEXT    NOT NULL DEFAULT '{}',    -- JSON
    metadata   TEXT    NOT NULL DEFAULT '{}',    -- JSON
    data       BLOB,                             -- artifact bytes (day 1, mostly NULL)
    prev       INTEGER REFERENCES nodes(id),                       -- order
    parent     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,    -- provenance
    owner      INTEGER REFERENCES nodes(id) ON DELETE CASCADE,     -- membership
    created_at TEXT    NOT NULL                  -- ISO-8601 UTC ms
);

CREATE UNIQUE INDEX nodes_owner_pub ON nodes(owner, public_id);          -- ids-B uniqueness
CREATE UNIQUE INDEX nodes_root_pub  ON nodes(public_id) WHERE owner IS NULL;
CREATE INDEX nodes_owner ON nodes(owner);

-- search: contentless FTS5, rows maintained by ops inside the write tx
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    text, content='', tokenize='unicode61 remove_diacritics 2'
);
```

Connection open order: `journal_mode=WAL` · `busy_timeout=5000` ·
`synchronous=NORMAL` · `foreign_keys=ON` · user_version check.

## Fase 3 — core (Workflow `core-tdd`)

Module map (`core/src/`):

| Module | What |
|---|---|
| `result.rs` | `Result<T>` / `UcError {code, message}` — 5 codes |
| `ids.rs` | public id gen (prefix + 24 hex, crypto rand) |
| `time.rs` | ISO timestamp gen + normalization (never throws) |
| `db.rs` | open: pragmas, DDL, user_version stamp/check, v1-file detect |
| `engine.rs` | chain walks: current head, ordered messages, version log |
| `view.rs` | MessageView assembly (+created_at), windowing (last/range/message), metadata filter |
| `ops/` | one file per op: `create` `fork` `append` `get` `update` `delete` `list` `search` `save` `load` |
| `fts.rs` | FTS maintenance (in-tx), query sanitizer, snippet |
| `fixtures.rs` | runner: walks `fixtures/*.json`, executes, asserts |

Portability rule (keeps 2.1 wasm alive): no tokio / `std::fs` /
`SystemTime` in the portable layer; rusqlite stays behind the default
`sqlite` feature; the wasm32 `cargo check` in CI is the tripwire.

Workflow shape (respects TDD — every module RED→GREEN):

1. **foundations** — one agent, sequential: result/ids/time/db/engine + tests
2. **ops wave 1** — parallel agents in worktrees: create+fork · append+get · list
3. **ops wave 2** — parallel: update+delete (copy-on-write, ids-B) · search+fts · save+load
4. **integration** — one agent: merge worktrees, fixture files per op
   (ported from `core/contract/v1-extraction.json` behaviors + new-op cases),
   full `cargo test` + clippy + fmt green
5. **adversarial review** — reviewer agents against CONTRACT/MODEL invariants
   (no-orphans, ids-B, version semantics, FTS-current-only), findings fixed

Deliverable: core green, fixture suite passing via `cargo test`. Gate: diff
summary + test counts presented for approval.

## Fase 4 — SDK JS (Workflow `sdk-js`)

- `sdks/js/`: napi-rs glue crate (logic-free) + `index.ts` thin wrapper
  (UltraContext class, Promise API, overloads get/delete, `err.code`)
- async mechanics: `#[napi]` async fns over `spawn_blocking` +
  `Mutex<Connection>`; tokio lives in the GLUE crate only, never core
- workspace member; `cargo test` stays core-only (glue is test-free)
- runner: `node:test` consuming `fixtures/*.json` against the BUILT binding
- bun smoke test
- Gate: same fixtures green on JS.

## Fase 5 — SDK Python (Workflow `sdk-py`)

- `sdks/python/`: PyO3 glue (logic-free, abi3) + thin `UltraContext`
  (sync, snake_case, same shapes/codes), maturin build
- runner: pytest consuming the same fixtures against the built wheel
- Gate: same fixtures green on Python. Surface diff JS↔Py = zero (modulo idiom).

## Fase 6 — release (own gate, nothing publishes without explicit go)

- `release.yml`: napi-rs official template (prebuild matrix, platforms first)
  + maturin official template (abi3 wheels) + cargo publish
- npm `@ultracontext` org platform packages · PyPI · crates.io (core only —
  glue crates `publish = false`)
- version single-sourced from the git tag: stamps Cargo workspace,
  `napi version` propagates npm packages, pyproject uses `dynamic` reading
  Cargo.toml — one source, zero drift
- PR CI runs on ubuntu + macos + windows (platform breakage surfaces on PR,
  not at the first release tag)
- dry-run via workflow_dispatch BEFORE any tag
- v1 note: `uc update` via npm would fetch a bin-less 2.0 — accepted break,
  release notes say so

## Out of scope (already in CONTRACT "Deferred")

Token counting, stats, since-cursor, preconditions/idempotency, compaction,
forked_from, artifact refs/dedupe, checkpoint, wasm (2.1), remote/hosted.
