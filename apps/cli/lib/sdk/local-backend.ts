// =============================================================================
// local-backend (NODE) — the swappable seam the facade imports as
// `#local-backend`. Builds the LOCAL backend by opening the node sqlite client
// (libsql/bun-sqlite) at the resolved db url. The browser build swaps this for
// ./local-backend.browser (sql.js + IndexedDB). One function, one shape; the
// facade never knows which one it got.
// =============================================================================

import type { Backend, LocalBackendConfig } from './local-backend-types';
import { toDbUrl } from './local-backend-types';

// -- loader -------------------------------------------------------------------

// open the node sqlite-backed ContextClient at the resolved db url. Dynamic
// import keeps the node client (core/storage/libsql) off the graph until a
// local call actually happens — remote-only consumers never load it.
export async function loadLocalBackend(cfg: LocalBackendConfig): Promise<Backend> {
    const dbUrl = toDbUrl(cfg.db ?? 'ultracontext.db');
    const { createLocalClient } = await import('../clients/local');
    const client = await createLocalClient({ dbUrl, cwd: process.cwd() });
    return { kind: 'local', client };
}
