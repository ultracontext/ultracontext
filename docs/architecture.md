# Architecture

UltraContext has one implementation source of truth: Rust under `core/`.
Language SDKs expose ergonomic clients and runtime entrypoints, but they should
not reimplement node-store, content-store, context-window, artifact, sync,
search, or filesystem semantics.

```
ultracontext/
  core/
    model/
    engine/
    adapters/
    bindings-js/
    bindings-python/

  cli/

  sdks/
    js/
    python/

  docs/
  fixtures/
  README.md
  Cargo.toml
  Cargo.lock
```

## Boundaries

`core/model` contains the product language: ids, node shapes, invariants,
contracts, and diagrams. It is documentation-first today.

`core/engine` contains the operational Rust implementation: workspaces,
sessions, context windows, artifacts, filesystem projection, sync, and search.
SQLite, local-dir, and S3 currently live here until extracting them creates
real clarity.

`core/adapters` is the intended home for infrastructure adapters. It documents
the boundary now; concrete crates can be added later without changing SDK
shape.

`core/bindings-js` and `core/bindings-python` expose the Rust dispatch API to
language packages. They should stay thin.

`cli/` owns the `uc` command, project config UX, and local NFS mount. It is a
product surface over the core, not part of the reusable engine boundary.

`sdks/js` and `sdks/python` are user-facing packages. They own naming,
entrypoints, config loading, browser/server splits, and package launchers. They
call Rust locally or the official HTTP protocol remotely.

## Rule

`core/` implements reusable behavior. `cli/` and `sdks/` present behavior.
`docs/` and `fixtures/` support behavior.
