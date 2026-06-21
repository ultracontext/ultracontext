# UltraContext Core

`core/` is the Rust implementation boundary. If behavior must be identical
across JS, Python, CLI, local, remote, and mounts, it belongs here.

```
core/
  model/             product model, contract, ids, invariants
  engine/            operations and current concrete Rust implementation
  adapters/          adapter boundary docs; split concrete adapters here later
  bindings-js/       N-API binding exposing Rust dispatch to JS
  bindings-python/   PyO3 binding exposing Rust dispatch to Python
  cli/               uc command and local NFS mount adapter
```

The current `engine` crate still contains the SQLite, local-dir, and S3
implementations. Those will move under `core/adapters` only when the split pays
for itself. Until then, the boundary is documented and the source of truth stays
in Rust.
