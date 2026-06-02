// =============================================================================
// resolve-client — pick the backing ContextClient. Local by default
// (sqlite + @ultracontext/core), remote when --remote is passed.
// Stub: returns a not-implemented Local client until the clients land.
// =============================================================================

import type { ContextClient } from './context-client';

// -- options ------------------------------------------------------------------

export type ResolveOptions = { remote?: boolean };

// -- placeholder client -------------------------------------------------------

// throws on every verb until LocalContextClient/RemoteContextClient are wired
function notImplemented(name: string): ContextClient {
    const stub = async () => {
        throw new Error(`${name} client not implemented`);
    };
    return { add: stub, get: stub, update: stub, delete: stub, list: stub };
}

// -- resolver -----------------------------------------------------------------

// choose remote vs local; both share the ContextClient interface
export function resolveClient(opts: ResolveOptions = {}): ContextClient {
    return opts.remote ? notImplemented('remote') : notImplemented('local');
}
