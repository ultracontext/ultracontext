// =============================================================================
// resolve-client — pick the backing ContextClient. LOCAL by default
// (sqlite + @ultracontext/core); remote ONLY on an explicit --remote flag or an
// explicit config mode:'remote'. Stale creds in the config must NOT hijack
// commands to remote. Both share the ContextClient interface, so the
// context verbs stay client-agnostic.
// =============================================================================

import type { ContextClient } from './context-client';
import { createLocalClient } from './clients/local';
import { createRemoteClientFromConfig } from './clients/remote';
import { loadClientConfig } from './client-config';
import { dbUrl as defaultDbUrl, projectDir as defaultProjectDir } from './config';

// -- options ------------------------------------------------------------------

// the persisted CLI config slice that selects/credentials the hosted backend.
// mode:'remote' is the explicit opt-in to use the hosted backend by default;
// without it (the norm) the CLI is local-first regardless of stored creds.
export type ClientConfig = { baseUrl?: string; apiKey?: string; mode?: 'local' | 'remote' };

// remote forces the hosted backend; dbUrl/cwd override the local defaults.
// env/config are injectable so credential resolution is testable without HTTP.
export type ResolveOptions = {
    remote?: boolean;
    dbUrl?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    config?: ClientConfig;
};

// -- credential resolution ----------------------------------------------------

// the api key from env (UC_API_KEY) first, else the persisted config
function resolveApiKey(env: Record<string, string | undefined>, config: ClientConfig): string | undefined {
    return env.UC_API_KEY ?? config.apiKey;
}

// the base url from env (UC_API_URL) first, else the persisted config
function resolveBaseUrl(env: Record<string, string | undefined>, config: ClientConfig): string | undefined {
    return env.UC_API_URL ?? config.baseUrl;
}

// -- resolver -----------------------------------------------------------------

// choose remote vs local; both share the ContextClient interface
export async function resolveClient(opts: ResolveOptions = {}): Promise<ContextClient> {
    const env = opts.env ?? process.env;

    // an explicit local-db signal — an opts.dbUrl override OR UC_DB_URL in env —
    // means "use this local db", so skip the persisted config (it can't flip us
    // to remote). Keeps env-driven local runs from reading a hosted config.
    const skipPersisted = opts.dbUrl !== undefined || env.UC_DB_URL !== undefined;

    // injected config wins (tests); else read the persisted ~/.ultracontext config
    const config = opts.config ?? (skipPersisted ? {} : await loadClientConfig());

    // gather hosted creds from env (preferred) or persisted config
    const apiKey = resolveApiKey(env, config);
    const baseUrl = resolveBaseUrl(env, config);

    // LOCAL-FIRST: remote only when explicitly requested — the --remote flag or
    // an explicit config mode:'remote'. Merely having creds in config does NOT
    // flip to remote (that would hijack every command on a configured machine).
    const wantRemote = opts.remote === true || config.mode === 'remote';

    // remote backend (hosted API) — backed by the @ultracontext/js SDK
    if (wantRemote) {
        // an explicit --remote without a key is a user error — fail clearly
        if (!apiKey) throw new Error('remote mode needs an api key — set UC_API_KEY or run `uc init`');
        return createRemoteClientFromConfig({ apiKey, baseUrl });
    }

    // local backend — env-aware db (UC_DB_URL else ~/.ultracontext/uc.db),
    // scoped to the env-aware project dir (UC_PROJECT_DIR else cwd). Defaults
    // flow through config so every verb resolves the SAME local store.
    return createLocalClient({
        dbUrl: opts.dbUrl ?? defaultDbUrl(),
        cwd: opts.cwd ?? defaultProjectDir(),
    });
}
