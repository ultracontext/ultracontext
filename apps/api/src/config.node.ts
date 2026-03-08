import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { buildApiConfig } from './config';
import type { ApiConfig } from './types';

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

// =============================================================================
// getApiConfig — Node.js only: loads dotenv, then delegates
// =============================================================================

export function getApiConfig(): ApiConfig {
    if (cachedConfig) return cachedConfig;
    loadEnv();
    cachedConfig = buildApiConfig(process.env);
    return cachedConfig;
}
