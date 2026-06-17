# PLAN - v2 reset

This repo's older v2 plan drifted from the product shape. Current direction:
UltraContext is a context SDK for AI applications, with local-first storage
where possible and an edge-safe remote path where necessary.

`core/MODEL.md` defines the data model. `core/CONTRACT.md` defines the product
contract. This file is the implementation plan and can change as decisions
settle.

## Current State

- `CLAUDE.md` is still the working-rule document.
- `core/MODEL.md` has been adapted to the node + artifact + content-ref model.
- `core/CONTRACT.md` has been reset around edge, local, artifacts, and agent
  file surfaces.
- The Rust core has a tested local SQLite alpha slice for contexts, fork, message
  versions, soft delete, permanent context scrub, inline/local-dir artifacts,
  path labels, file verbs, conflicts, FTS-backed search with fallback, listing,
  artifact scrub, snapshot export/import, and a JSON dispatch boundary for
  local SDK bindings.
- The JS SDK has a fetch-only remote client, a fetch-compatible server handler,
  a local N-API binding path over the Rust JSON dispatch, and server-only
  SQLite/Postgres reference engines behind the same protocol. Content stores
  include local-dir for SQLite/local native and injected S3-compatible storage
  for Postgres/server deployments. The local N-API binding has been built and
  smoke-tested on macOS.
- The Python SDK has a stdlib remote client plus a PyO3 native binding crate
  wired to the Rust JSON dispatch boundary. A local Python 3.12 venv has been
  tested with `maturin develop`, local SQLite mode, local-dir content storage,
  and wheel install.
- The Rust CLI crate ships the `uc` binary with context/file commands,
  materialization, sync-dir, and a FUSE-backed `uc mount` adapter behind the
  optional `fuse` feature.

## Shippable v2 Goal

Ship a small but real SDK that supports:

1. Local apps and agents with a plain SQLite node store.
2. Edge/serverless apps through a fetch-only remote client.
3. Versioned artifacts for markdown, text, images, and other AI inputs/outputs.
4. A path projection over artifacts so agents can use file-like verbs.
5. Identical behavior across JS and Python where both environments support it.

Do not ship a distributed filesystem. Do not mount S3 as SQLite. Do not make
JuiceFS, S3-FUSE, or kernel mounts dependencies of the core. FUSE is a
first-class optional adapter over the file verbs, not the storage model.

## Architecture Blocks

### Core Domain

Rust core owns:

- public id generation;
- node graph invariants;
- context create/fork/append/get/update/delete;
- artifact save/load/delete with stable `art_` identity;
- path normalization and path-to-artifact lookup;
- artifact versioning and `ifVersion` conflicts;
- FTS-backed search over current text messages and text artifacts with
  conservative scan fallback;
- SQLite local adapter.
- JSON dispatch for thin local language bindings.
- snapshot export/import for a first mirror path.

Core does not own:

- provider-specific prompt formats;
- hosted auth/billing;
- kernel mount implementation details; FUSE lives in an adapter over file verbs;
- S3 SDK policy beyond a content-store interface.

### JS SDK

JS needs two execution paths:

- **remote edge path**: fetch-only, no native import, works in Vercel Edge and
  similar runtimes. Status: implemented in `sdks/js/src/index.js` with
  `node:test` coverage, including protocol and server handler tests;
- **local native path**: Node/Bun binding to the Rust core for local apps and
  agents. Status: implemented through `sdks/js/native/`, built and
  smoke-tested on macOS.

The SDK must avoid importing local native code when configured for remote
mode. This is a product requirement, not an optimization.

Binding crate location: the N-API crate lives under `sdks/js/native/` as a
packaging detail of the JS SDK. It links to `core/` and must not contain domain
logic.

### Python SDK

Python ships:

- local native binding. Status: implemented through `sdks/python/native/` and
  tested with `maturin develop` in a Python 3.12 venv;
- remote HTTP client with the same shapes and error codes. Status: implemented
  in `sdks/python/ultracontext/client.py` with `unittest` coverage.

Python does not need edge constraints, but it must preserve contract parity.

Binding crate location: the PyO3 crate lives under `sdks/python/native/` as a
packaging detail of the Python SDK. It links to `core/` and must not contain
domain logic.

### Content Stores

Start with:

- inline content for text/markdown and small data;
- local directory content store for larger local bytes;
- S3-compatible content store behind remote/server-side environments.

The domain object stores a `storage` descriptor. The content-store driver is
replaceable.

### Agent File Surface

Build file verbs over artifacts and let every file surface share them:

- list;
- read;
- write;
- move;
- remove;
- glob;
- grep.

Expose them as SDK helpers, local materialization, and the FUSE/native mount.
The mount is a product feature, but it stays outside the core storage layer.

### CLI

The CLI is the local operator surface:

- `uc create`
- `uc contexts`
- `uc file list/read/write/mv/rm/glob/grep`
- `uc materialize`
- `uc sync-dir`
- `uc mount` with the optional FUSE feature

The CLI links to the Rust core and must not reimplement domain rules.

## Implementation Phases

### Phase 0 - Spec Reset

Done in docs:

- update `core/MODEL.md`;
- update `core/CONTRACT.md`;
- update this plan;
- update README and SDK READMEs to stop advertising stale scope.

Gate: user agrees the spec matches the product direction.

### Phase 1 - Rust Core, Local SQLite

Status: done for alpha. The first vertical slice is implemented in `core/` and
covered by `core/tests/core_behavior.rs`.

TDD, vertical slices:

1. DONE - Foundation: result/error types, ids, time, path normalization.
2. DONE - SQLite schema and open checks.
3. DONE - Context lifecycle: create, get/list, append.
4. DONE - Context versioning: message update, fork, soft delete, and time
   travel are in.
5. DONE - Artifacts: save/load inline text, path upsert, id-targeted update,
   rename.
6. DONE - Artifact conflicts: `ifVersion` mismatch returns `conflict`.
7. DONE - Binary/content refs: inline and local-dir storage exist in core.
8. DONE - Search: FTS5-backed candidate search with scan fallback.
9. DONE - Permanent delete: context and artifact scrub exist.
10. DONE - Binding boundary: JSON dispatch returns remote-compatible shapes
    and stable coded errors.

Deliverable: `cargo test` green for core.

### Phase 2 - JS Remote Client and Protocol

Status: done for alpha. A fetch-only ESM client exists and is tested with a
mock fetch. A fetch-compatible handler also exists and dispatches the protocol
to an injected engine/store. Server-only SQLite and Postgres reference engines
exist behind the same handler shape.

Build the edge-safe surface before native packaging:

1. DONE - Define the HTTP protocol from `core/CONTRACT.md` in executable
   client/handler tests; full prose protocol docs can follow.
2. DONE - Implement a fetch-only JS client.
3. DONE - Add tests that run without native bindings.
4. DONE - Add a minimal self-hostable handler shape for Node/server runtimes.
5. DONE - Add a SQLite-backed reference engine for self-hosted tests.
6. DONE - Add a Postgres-backed reference engine for remote/server deployments.

Deliverable: JS remote mode works in an edge-like test environment.

### Phase 3 - JS Local Native

Add the local adapter:

1. DONE - napi-rs binding calls Rust JSON dispatch; no domain logic in JS.
2. DONE - JS wrapper chooses remote or local without bundling native code into remote
   mode.
3. DONE - Local N-API build and smoke test work on macOS.
4. DONE - Same shared fixture suite runs against JS local native and JS remote.

Deliverable: JS local and remote pass the same behavior tests where applicable.

### Phase 4 - Python SDK

1. DONE - PyO3/maturin binding calls Rust JSON dispatch; no domain logic in
   Python.
2. DONE - Python wrapper can dispatch remote or local mode with stable
   `UltraContextError.code`.
3. DONE - `maturin develop` works in a local Python 3.12 venv and local SQLite
   mode has been smoke-tested.
4. DONE - Same fixture suite runs against Python local native and Python
   remote transport; release wheel build and install have been verified.

Deliverable: Python parity for local and remote shapes.

### Phase 5 - Shared Fixture Suite

Status: done for alpha.

Create one executable behavior matrix for the product contract. The same
scenarios should run against:

- Rust core JSON dispatch;
- JS local native mode;
- JS remote mode through the handler;
- Python local native mode;
- Python remote mode through a fixture transport.

Scenarios:

1. Context lifecycle: create, append, get, update, delete, fork.
2. Artifact lifecycle: save, load, rename, version reads, conflicts.
3. File verbs: write, read, list, glob, grep, move, remove.
4. Error envelopes: `not_found`, `invalid_input`, `conflict`.

Deliverable: one fixture source of truth and per-runtime adapters that prove
parity.

### Phase 6 - Content Store Drivers

Status: partially done.

1. DONE - Local directory content store in Rust core, JS SQLite engine, JS
   local native, and Python local native.
2. DONE - S3-compatible content store for server-side Postgres deployments via
   injected client.
3. DONE - Cached hybrid local plus remote content store for JS/server-side
   deployments.

Deliverable: artifacts can be inline, local-dir, or S3-backed without changing
SDK calls.

### Phase 7 - Release Packaging

Status: done for alpha validation. CI builds installable packages plus native
artifacts across OS matrices.

1. DONE - JS package validates `npm pack` and package exports.
2. DONE - JS native binding builds in CI across Linux/macOS/Windows and uploads
   prebuild artifacts.
3. DONE - Python package validates `maturin build` and wheel install in a fresh
   venv.
4. DONE - CI installs built packages and runs smoke tests against installed
   artifacts.

Deliverable: users can install the alpha package, not only run source-tree
tests.

### Phase 8 - Search FTS

Status: done for Rust core/local SQLite.

Replace the simple scan with an indexed search path where SQLite supports FTS5.
Keep a conservative fallback for environments where FTS5 is unavailable.

Deliverable: search remains API-compatible but stops depending on full scans
for normal local databases.

### Phase 9 - Sync/Mirror

Status: done for alpha.

After content stores exist, ship a minimum mirror block:

1. DONE - Export/import node rows with stable ids and timestamps.
2. DONE - Include referenced blob content in snapshot imports.
3. DONE - Preserve append-only history and report structural node conflicts on
   import.

Deliverable: a local store can push/pull nodes plus blobs without mounting S3
as a filesystem.

### Phase 10 - Agent Surface

1. DONE - SDK file helpers.
2. DONE - Local materialization to real directories and sync-back from edited
   files.
3. DONE - CLI surface for context/file/materialize/sync-dir operations.
4. DONE - FUSE/native mount implementation over the same file verbs, gated
   behind the CLI's optional `fuse` feature.

Deliverable: an agent can read/edit markdown artifacts through file-like verbs;
FUSE gives local agents a real filesystem view without becoming a core storage
dependency.

## Non-Goals for v2.0

- CRDT collaborative editing.
- SQLite-on-S3, JuiceFS, or S3-FUSE as core storage.
- Browser-embedded SQLite as the default product path.
- Full managed hosted platform.
- FUSE as the core storage model.
- Provider-specific prompt serialization.
- Garbage collection UI for orphaned blobs.

## Remaining Later Work

- CRDT merges for same-document concurrent edits.
- FUSE/native mount packaging, installer checks, and macOS/Linux smoke tests on
  hosts with FUSE installed.
- Hosted auth/billing and managed service operations.
