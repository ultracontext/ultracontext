import type { ApiConfig } from './types';

let cachedConfig: ApiConfig | null = null;

function requireEnv(name: keyof ApiConfig): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

export function getApiConfig(): ApiConfig {
    if (cachedConfig) return cachedConfig;

    cachedConfig = {
        DATABASE_URL: requireEnv('DATABASE_URL'),
        ULTRACONTEXT_ADMIN_KEY: requireEnv('ULTRACONTEXT_ADMIN_KEY'),
    };

    return cachedConfig;
}
