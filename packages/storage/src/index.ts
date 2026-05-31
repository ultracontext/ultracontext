import type { StorageAdapter } from '@ultracontext/core';
import { createDbClient } from './db';
import { DrizzleAdapter } from './drizzle';
import { SupabaseAdapter } from './supabase';

// =============================================================================
// ADAPTER FACTORY — picks the right backend based on config
// =============================================================================

// Minimal storage config — decoupled from any consumer's app config. Callers
// (e.g. apps/api ApiConfig) are structurally compatible and may carry extra fields.
export type StorageConfig =
    | { DATABASE_PROVIDER: 'postgres'; DATABASE_URL: string }
    | { DATABASE_PROVIDER: 'supabase'; SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
    if (config.DATABASE_PROVIDER === 'supabase') {
        return new SupabaseAdapter(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    }
    return new DrizzleAdapter(createDbClient(config.DATABASE_URL));
}

// -- re-exports ---------------------------------------------------------------

export type { StorageAdapter } from '@ultracontext/core';
export { DrizzleAdapter } from './drizzle';
export { SupabaseAdapter } from './supabase';
