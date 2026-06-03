// =============================================================================
// createBrowserLocalClient — the BROWSER factory for the local ContextClient.
// Opens a sql.js + IndexedDB adapter (no server, no key, no node fs) via
// @ultracontext/storage/sqlite-browser, ensures the single 'local' project,
// then hands both to the pure LocalContextClient (./local-client). ZERO node:
// imports — the sqlite-browser adapter is dynamically imported so a remote-only
// browser app never pulls in sql.js's wasm bytes.
// =============================================================================

import type { ContextClient } from '../context-client';
import { ensureProject } from '../context-resolver';

import { LocalContextClient } from './local-client';

// -- types --------------------------------------------------------------------

// the browser client is a ContextClient that ALSO exposes flush() — a web app
// can force the IndexedDB snapshot out before navigating away (saves are
// otherwise debounced). The node client has no flush (libsql persists eagerly).
export type BrowserContextClient = ContextClient & { flush(): Promise<void> };

// -- factory ------------------------------------------------------------------

// open the browser adapter (sql.js engine + IndexedDB snapshot persistence) under
// `name`, ensure the project, then build the client. `wasmUrl` overrides the
// sql.js wasm location for bundlers / fully-offline apps (CDN default otherwise).
export async function createBrowserLocalClient(opts: { name: string; wasmUrl?: string }): Promise<BrowserContextClient> {
    const { createBrowserSqliteAdapter } = await import('@ultracontext/storage/sqlite-browser');
    const storage = await createBrowserSqliteAdapter({ name: opts.name, wasmUrl: opts.wasmUrl });
    const projectId = await ensureProject(storage);

    // the pure client over the adapter, with the adapter's flush() surfaced so a
    // web app can persist on demand (the adapter still auto-saves on mutations).
    const client = new LocalContextClient(storage, projectId);
    return Object.assign(client, { flush: () => storage.flush() });
}
