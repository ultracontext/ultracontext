# UltraContext

The context SDK for AI agents. One fast Rust core, thin SDKs in every language.

> **Status: 2.0 rebuild in progress** on `feat/v2`. v1 source lives at tag `v1-final`; v1 packages stay published.

- **Local-first** — your contexts live in a plain SQLite file you own. Open it with anything. No server, no api key, no telemetry.
- **Server-side, like any database** — runs where your app runs (Node, Bun, Python; Next.js API routes, agents, CLIs). Your frontend talks to your app, your app talks to UltraContext.
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

## License

Apache-2.0
