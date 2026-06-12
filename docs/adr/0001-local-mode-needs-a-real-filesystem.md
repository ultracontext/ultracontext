# Local mode needs a real filesystem; browsers and edge consume via a server

UltraContext's core is an embedded SQLite engine. Local mode therefore runs only where a
durable filesystem exists: Node/Bun, Python, desktop, CLI, mobile — always server-side (or
device-side). Browsers and edge runtimes never touch the database: the browser is a client
of the dev's own server routes (which enforce authorization — the core has no tenancy),
and edge runtimes have no durable disk by design. Both are served by remote mode — a pure
HTTP client speaking the same op contract, validated by the same fixtures — landing in 2.x;
in 2.0 devs write their own thin routes.

## Considered options

- **Compile the core to wasm for in-browser persistence (OPFS)** — rejected: browser
  storage is sandboxed, evictable, and device-bound, which contradicts Ownership and
  Transparency (no inspectable file) and breaks cross-device continuity. No real user asks
  for it. Returns only on real demand.
- **Network layer inside the Rust core (reqwest)** — rejected: remote mode is a thin HTTP
  client in each SDK's own language; the core never learns the network.

## Consequences

- 2.0 ships native only: napi (JS) + PyO3 (Python) over one Rust core.
- Cheap hygiene keeps doors open: no network deps in the core, engine clock behind a seam.
- The "server speaking the contract" for remote mode (mountable handler, hosted API, new
  binary) is an open 2.x question — nothing in 2.0 depends on it.
