// =============================================================================
// client-config — read the persisted config.json into the {baseUrl, apiKey}
// slice the client resolver needs. Empty when the file is absent or partial,
// so callers fall back to env vars or the local backend.
// =============================================================================

import { configPath, readJson } from './config';
import type { ClientConfig } from './resolve-client';

// -- loader -------------------------------------------------------------------

// extract the hosted-backend slice from the persisted config (defaults to the
// real config path; overridable for tests)
export async function loadClientConfig(path: string = configPath()): Promise<ClientConfig> {
    // read the whole config file; null → no file yet → empty slice
    const raw = await readJson<{ baseUrl?: string; apiKey?: string }>(path);
    if (!raw) return {};

    // surface only the fields that are present (no undefined keys)
    const cfg: ClientConfig = {};
    if (raw.baseUrl) cfg.baseUrl = raw.baseUrl;
    if (raw.apiKey) cfg.apiKey = raw.apiKey;
    return cfg;
}
