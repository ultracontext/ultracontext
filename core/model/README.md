# Model

This directory holds the product contract and model language. It is not a Rust
crate yet.

- `MODEL.md` explains the node model, version chains, workspaces, sessions,
  context windows, and artifacts.
- `CONTRACT.md` defines the v2 product/API contract.
- `contract/v1-extraction.json` is historical input from v1 behavior.

Code may move between Rust crates, but the language here is the source of truth
for what UltraContext means.
