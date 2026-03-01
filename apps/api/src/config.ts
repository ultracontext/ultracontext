import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import type { ApiConfig, DatabaseProvider } from './types';

let cachedConfig: ApiConfig | null = null;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const ROOT_ENV_PATH = path.join(REPO_ROOT, '.env');
const APP_LOCAL_ENV_PATH = path.join(APP_ROOT, '.env.local');
const APP_ENV_PATH = path.join(APP_ROOT, '.env');

function loadEnv() {
    const explicitPath = String(process.env.DOTENV_CONFIG_PATH ?? '').trim();
    if (explicitPath) {
        dotenv.config({ path: explicitPath, override: true });
        return;
    }

    const rootResult = dotenv.config({ path: ROOT_ENV_PATH, override: true });
    if (!rootResult.error) return;

    const localResult = dotenv.config({ path: APP_LOCAL_ENV_PATH, override: true });
    if (!localResult.error) return;

    dotenv.config({ path: APP_ENV_PATH, override: true });
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function requireDatabaseProvider(): DatabaseProvider {
    const value = String(process.env.DATABASE_PROVIDER ?? '').trim().toLowerCase();
    if (value === 'postgres' || value === 'supabase') {
        return value;
    }
    throw new Error('Missing or invalid env var: DATABASE_PROVIDER (expected "postgres" or "supabase")');
}

export function getApiConfig(): ApiConfig {
    if (cachedConfig) return cachedConfig;
    loadEnv();

    const provider = requireDatabaseProvider();
    const adminKey = requireEnv('ULTRACONTEXT_ADMIN_KEY');

    if (provider === 'postgres') {
        cachedConfig = {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: requireEnv('DATABASE_URL'),
            ULTRACONTEXT_ADMIN_KEY: adminKey,
        };
        return cachedConfig;
    }

    cachedConfig = {
        DATABASE_PROVIDER: 'supabase',
        SUPABASE_URL: requireEnv('SUPABASE_URL'),
        SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
        ULTRACONTEXT_ADMIN_KEY: adminKey,
    };

    return cachedConfig;
}
