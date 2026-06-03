// =============================================================================
// local-backend (BROWSER) — the browser half of the swappable `#local-backend`
// seam. Builds the LOCAL backend on sql.js + IndexedDB (no server, no key, no
// node fs). Same `loadLocalBackend(cfg)` shape as the node seam; the browser
// build aliases `#local-backend` to THIS file. ZERO node: imports — the sql.js /
// sqlite-browser code sits behind a dynamic import (clients/local-browser) so a
// remote-only browser app never downloads the wasm engine.
// =============================================================================

import type { Backend, LocalBackendConfig } from './local-backend-types';

// -- loader -------------------------------------------------------------------

// open the browser sqlite-backed ContextClient. `db` becomes the IndexedDB
// record name (a leading `file:` from node-style configs is stripped); `wasmUrl`
// overrides the sql.js wasm location for bundlers / fully-offline apps.
export async function loadLocalBackend(cfg: LocalBackendConfig): Promise<Backend> {
    // edge runtimes (no IndexedDB AND no window) cannot persist — fail loudly
    // with an actionable message instead of silently losing the user's context.
    const hasIdb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
    const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
    if (!hasIdb && !hasWindow) {
        throw new Error(
            "local mode needs a persistent runtime (a browser with IndexedDB) — this edge/server runtime has neither. Pass { apiKey } to use the hosted API instead.",
        );
    }

    // a node-style `file:`/path db maps to a plain IndexedDB record name
    const name = stripFileScheme(cfg.db ?? 'ultracontext.db');

    // dynamic import keeps sql.js's wasm off the graph until a local call happens
    const { createBrowserLocalClient } = await import('../clients/local-browser');
    const client = await createBrowserLocalClient({ name, wasmUrl: cfg.wasmUrl });
    return { kind: 'local', client };
}

// -- helpers ------------------------------------------------------------------

// drop a leading `file:` so a node-shaped db config still names an IDB record
function stripFileScheme(db: string): string {
    return db.startsWith('file:') ? db.slice('file:'.length) : db;
}
