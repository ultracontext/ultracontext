// =============================================================================
// local-backend-types — the shared, IMPORT-PURE contract for the local-backend
// seam. Both seam implementations (./local-backend node, ./local-backend.browser)
// and the facade import from here, so the swappable `#local-backend` module only
// ever exports `loadLocalBackend` — no types cross the seam (which would couple
// the two builds). ZERO node: imports — safe to land in the browser bundle.
// =============================================================================

import type {
    UltraContext as RemoteUltraContext,
} from '@ultracontext/js';

import type { ContextClient } from '../context-client';

// -- backend port -------------------------------------------------------------

// the lazily-built backend: a remote SDK instance, or a local ContextClient
// tagged so the facade can adapt its object-arg verbs to the public signatures.
export type Backend =
    | { kind: 'remote'; sdk: RemoteUltraContext }
    | { kind: 'local'; client: ContextClient };

// -- local backend config -----------------------------------------------------

// the subset of UltraContextConfig a local loader needs: the sqlite/db target
// (`db`) and the browser-only sql.js wasm override (`wasmUrl`, ignored in node).
export type LocalBackendConfig = {
    db?: string;
    wasmUrl?: string;
};

// -- db url normalization -----------------------------------------------------

// a db string carrying a leading scheme (file:/libsql:/http — two+ chars before
// the colon) is used as-is; anything else is a local file path, `file:`-prefixed.
// A SINGLE-letter prefix (a Windows drive like C:) is a path, not a scheme. A
// multi-char leading token (`data:base.db`) still reads as a scheme — prefix
// `./` to force a path. Exported for tests; mirrored by the Python SDK.
export function toDbUrl(db: string): string {
    return /^[a-z][a-z0-9+.-]+:/i.test(db) ? db : `file:${db}`;
}
