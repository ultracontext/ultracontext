import type { ApiConfig } from '../types/api';
import { createDbClient } from '../db';
import { DrizzleAdapter } from './drizzle';
import { SupabaseAdapter } from './supabase';
import type { StorageAdapter } from './types';

// =============================================================================
// ADAPTER FACTORY — picks the right backend based on config
// =============================================================================

export function createStorageAdapter(config: ApiConfig): StorageAdapter {
    if (config.DATABASE_PROVIDER === 'supabase') {
        return new SupabaseAdapter(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    }
    return new DrizzleAdapter(createDbClient(config.DATABASE_URL));
}

// -- re-exports ---------------------------------------------------------------

export type { StorageAdapter } from './types';
export { DrizzleAdapter } from './drizzle';
export { SupabaseAdapter } from './supabase';
