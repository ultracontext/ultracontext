import { KvKeyCache } from './cache/kv';
import { buildApiConfig } from './config';
import { createApp } from './app';
import { SupabaseAdapter } from './storage/supabase';

// =============================================================================
// CF WORKERS ENTRYPOINT
// =============================================================================

type Env = {
    DATABASE_PROVIDER: string;
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ULTRACONTEXT_ADMIN_KEY: string;
    ULTRACONTEXT_API_KEYS_CACHE?: KVNamespace;
};

// cached per worker instance
let app: ReturnType<typeof createApp> | null = null;

export default {
    fetch(request: Request, env: Env): Response | Promise<Response> {
        if (!app) {
            const config = buildApiConfig(env as unknown as Record<string, string | undefined>);
            if (config.DATABASE_PROVIDER !== 'supabase') {
                throw new Error('CF Workers only supports Supabase storage');
            }
            const storage = new SupabaseAdapter(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

            const keyCache = env.ULTRACONTEXT_API_KEYS_CACHE
                ? new KvKeyCache(env.ULTRACONTEXT_API_KEYS_CACHE)
                : undefined;

            app = createApp({ config, storage, keyCache });
        }

        return app.fetch(request);
    },
};
