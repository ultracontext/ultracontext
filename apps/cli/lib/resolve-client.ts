// =============================================================================
// resolve-client — pick the backing ContextClient. Local by default
// (sqlite + @ultracontext/core), remote when --remote or when config/env carry
// a hosted baseUrl + token. Both share the ContextClient interface, so the
// context verbs stay client-agnostic.
// =============================================================================

import type { ContextClient } from './context-client';
import { createLocalClient } from './clients/local';
import { createRemoteClientFromConfig } from './clients/remote';
import { loadClientConfig } from './client-config';
import { dbUrl as defaultDbUrl, projectDir as defaultProjectDir } from './config';

// -- options ------------------------------------------------------------------

// the persisted CLI config slice that selects/credentials the hosted backend
export type ClientConfig = { baseUrl?: string; apiKey?: string };

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

    // remote is chosen by an explicit --remote, or implicitly when config has both
    const wantRemote = opts.remote || Boolean(baseUrl && apiKey);

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
