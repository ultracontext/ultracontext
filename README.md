# UltraContext

The context SDK for AI applications. It manages conversations, artifacts, and
agent-created files across local and edge/serverless environments.

> Status: v2 alpha implementation in progress. Core, JS, Python, content
> stores, shared fixtures, package checks, FTS search, and snapshot mirror are
> in place. `core/MODEL.md` and `core/CONTRACT.md` are the product sources of
> truth.

- **Edge-safe** - JS remote mode is fetch-only, so Vercel Edge-style apps do
  not need SQLite, native bindings, or a persistent filesystem. The first
  fetch-only JS client lives in `sdks/js`.
- **Self-hostable path** - the JS package includes a fetch-compatible handler,
  SQLite/Postgres reference engines, local-dir blobs, and injected
  S3-compatible blob storage.
- **Local-first where possible** - local apps, CLIs, and agents can use a plain
  SQLite node store they own and can inspect.
- **Thin language bindings** - the Rust core exposes a JSON dispatch boundary
  so JS/Python local mode can call the same semantics as remote mode.
- **Artifacts built in** - markdown drafts, images, screenshots, and generated
  files are versioned artifacts, not ad hoc filesystem side effects.
- **File ergonomics for agents** - artifacts have paths and file-like verbs;
  local materialization and the planned FUSE adapter project the same namespace
  into real files.
- **LEGO blocks** - node store, content store, remote protocol, SDKs, search,
  mirror, and file surfaces are replaceable blocks behind one domain model.

## Layout

| Dir | What |
|---|---|
| `core/` | Rust core, model, and product contract |
| `docs/` | Protocol and implementation notes |
| `sdks/js` | JS/TS SDK, remote edge client, local N-API binding, server engines |
| `sdks/python` | Python SDK, remote client, local PyO3 binding |

## License

Apache-2.0
