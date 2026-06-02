// =============================================================================
// resolve-client — pick the backing ContextClient. Local by default
// (sqlite + @ultracontext/core), remote when --remote (or config) asks.
// The remote client lands in the Remote phase; for now it throws clearly.
// =============================================================================

import type { ContextClient } from './context-client';
import { createLocalClient } from './clients/local';
import { dbUrl as defaultDbUrl } from './config';

// -- options ------------------------------------------------------------------

// remote toggles the hosted backend; dbUrl/cwd override the local defaults
export type ResolveOptions = { remote?: boolean; dbUrl?: string; cwd?: string };

// -- remote stub --------------------------------------------------------------

// every verb throws until RemoteContextClient (@ultracontext/js) is wired
function remoteStub(): ContextClient {
    const stub = async (): Promise<never> => {
        throw new Error('remote client not implemented');
    };
    return { add: stub, get: stub, update: stub, delete: stub, list: stub };
}

// -- resolver -----------------------------------------------------------------

// choose remote vs local; both share the ContextClient interface
export async function resolveClient(opts: ResolveOptions = {}): Promise<ContextClient> {
    // remote backend (hosted API) — stubbed until the Remote phase
    if (opts.remote) return remoteStub();

    // local backend — sqlite at ~/.ultracontext/uc.db, scoped to the cwd
    return createLocalClient({
        dbUrl: opts.dbUrl ?? defaultDbUrl(),
        cwd: opts.cwd ?? process.cwd(),
    });
}
