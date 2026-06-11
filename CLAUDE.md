# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

UltraContext 2.0 — the context SDK for AI agents. One Rust core consumed
in-process (FFI) by thin language SDKs. Local-first: plain SQLite file,
no server, no api key, zero telemetry. v1 source: tag `v1-final`.

## Philosophy (load-bearing for every decision)

1. **Legofy it** — configurable > customizable; user composes blocks.
2. **Just works** — factory defaults are already great; building yourself is optional.
3. **Transparency builds trust** — show everything; plain inspectable formats.
4. **Speed matters.**
5. **Ownership** — the data and the stack are the user's; no vendor lock-in.
6. **Simplicity** — simple beats complex; less beats more.

## Layout (component-axis root)

| Dir | What |
|---|---|
| `core/` | Rust crate `ultracontext` — node engine + SQLite (rusqlite bundled, FTS5) behind a storage trait |
| `sdks/js` | npm `ultracontext` — napi-rs glue + thin TS wrapper, Promise API |
| `sdks/python` | PyPI `ultracontext` — PyO3 glue + thin wrapper, sync API, maturin abi3 wheels |

Future blocks land at root: `mirror/`, `cli/`, `docs/`. Languages multiply
inside `sdks/`, components multiply at root.

## Data model — everything is a node

See `core/MODEL.md`. One `nodes` table: `prev_id` = message order (linked
list), `parent_id` = version history (every op creates a new context head).
Versions, fork, time-travel, and recoverable delete all derive from the two
pointers. `delete({permanent: true})` = real scrub from all versions —
destruction is always explicit.

## SDK surface rule

Identical surface in JS and Python: same methods, params, return shapes,
and error codes. Only await-ness differs (JS Promise, Python sync — each
language's idiom). Parity is enforced mechanically by a shared JSON fixture
suite run through both built SDKs against the same core.

## Core rules

- Glue crates (napi/pyo3) are logic-free and test-free; all logic and tests
  live in the core rlib.
- Every db open sets PRAGMAs: `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`. `user_version` stamped from the
  first release; a v1 db file is detected and fails with a stable error.
- Keep core portable for the 2.1 wasm target: no tokio / `std::fs` /
  `SystemTime` in the portable layer; rusqlite behind a default cargo
  feature; `cargo check --target wasm32-unknown-unknown --no-default-features`
  stays in CI.
- Errors: `Result` everywhere, stable string codes. Envelope
  `UcError { code, message }` → JS `err.code` / Python exception `.code`.

## Commands

```bash
cargo test -p ultracontext        # core tests (the suite that matters)
cargo clippy --all-targets        # lint
cargo fmt                         # format
# SDK tests run against BUILT artifacts (napi build / maturin develop)
```

## TDD (mandatory)

Every module is RED (failing test first) → GREEN (implement).

## Style

- Rust: rustfmt defaults; one short semantic comment atop each logical block
  + a blank line between blocks.
- TS wrapper: 4-space indent, single quotes, kebab-case files, ESM.

## Conventions

- **Commits**: Conventional Commits. NEVER add `Co-Authored-By` (hard rule).
- **Branch**: work on `feat/v2`. Do not push, open PRs, or touch `main`.
- **Out of 2.0** (return additively later): wasm/browser/edge (2.1),
  remote/hosted mode, mirror/sync, events, drivers, MCP server, the `uc` CLI.
- Publishing (Phase 6): npm `ultracontext` + `@ultracontext/<target>`
  platform packages (platforms first, main last), PyPI `ultracontext`,
  crates.io `ultracontext` (glue crates `publish = false`). Version
  single-sourced from the git tag.
