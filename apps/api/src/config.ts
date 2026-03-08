import type { ApiConfig, DatabaseProvider } from './types';

// =============================================================================
// buildApiConfig — runtime-agnostic, no Node.js deps
// =============================================================================

function requireFrom(env: Record<string, string | undefined>, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function resolveProvider(env: Record<string, string | undefined>): DatabaseProvider {
    const value = String(env.DATABASE_PROVIDER ?? '').trim().toLowerCase();
    if (value === 'postgres' || value === 'supabase') return value;
    throw new Error('Missing or invalid env var: DATABASE_PROVIDER (expected "postgres" or "supabase")');
}

export function buildApiConfig(env: Record<string, string | undefined>): ApiConfig {
    const provider = resolveProvider(env);
    const adminKey = requireFrom(env, 'ULTRACONTEXT_ADMIN_KEY');

    if (provider === 'postgres') {
        return {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: requireFrom(env, 'DATABASE_URL'),
            ULTRACONTEXT_ADMIN_KEY: adminKey,
        };
    }

    return {
        DATABASE_PROVIDER: 'supabase',
        SUPABASE_URL: requireFrom(env, 'SUPABASE_URL'),
        SUPABASE_SERVICE_ROLE_KEY: requireFrom(env, 'SUPABASE_SERVICE_ROLE_KEY'),
        ULTRACONTEXT_ADMIN_KEY: adminKey,
    };
}
