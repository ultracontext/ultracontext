# UltraContext

The context SDK for AI agents. One fast Rust core, thin SDKs in every language.

> **Status: 2.0 rebuild in progress** on `feat/v2`. v1 source lives at tag `v1-final`; v1 packages stay published.

- **Local-first** — your contexts live in a plain SQLite file you own. Open it with anything. No server required, no api key, no telemetry.
- **Remote when you need it** — browser and edge consume the same surface over HTTP against a tiny self-hosted server. Native where there's a filesystem, thin client where there isn't.
- **Versioned** — every context is an append-only node chain: time-travel, fork, recoverable delete.
- **Search built-in** — full-text search over your contexts (FTS5).
- **One core, every language** — `npm i ultracontext` (Node/Bun) · `pip install ultracontext` (Python). Same surface, same behavior, proven by a shared fixture suite.

## Philosophy

Configurable > customizable · it just works · transparency builds trust · speed matters · the data and the stack are yours · simple beats complex.

## Layout

| Dir | What |
|---|---|
| `core/` | Rust engine — node model + SQLite |
| `sdks/js` | npm `ultracontext` |
| `sdks/python` | PyPI `ultracontext` |
| `server/` | self-host HTTP server — remote mode for browser/edge |

## License

Apache-2.0
