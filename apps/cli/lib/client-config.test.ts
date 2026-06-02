// =============================================================================
// client-config.test — loadClientConfig reads the persisted config.json into a
// {baseUrl, apiKey} slice, returning empty when the file is absent or partial.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { loadClientConfig } from './client-config';
import { writeJsonAtomic } from './config';

// -- temp dir cleanup ---------------------------------------------------------

const tmpDirs: string[] = [];
function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-client-cfg-'));
    tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// -- loading ------------------------------------------------------------------

describe('loadClientConfig', () => {
    // a full config → both fields surface
    it('reads baseUrl + apiKey from the persisted config', async () => {
        const file = path.join(tmpDir(), 'config.json');
        await writeJsonAtomic(file, { baseUrl: 'https://api.example.com', apiKey: 'sk_x', agent: 'claude' });

        const cfg = await loadClientConfig(file);
        assert.deepEqual(cfg, { baseUrl: 'https://api.example.com', apiKey: 'sk_x' });
    });

    // a missing file → empty slice (callers fall back to env/local)
    it('returns an empty slice when the file is absent', async () => {
        const cfg = await loadClientConfig(path.join(tmpDir(), 'missing.json'));
        assert.deepEqual(cfg, {});
    });

    // a partial config → only the present field surfaces
    it('returns only the fields that are present', async () => {
        const file = path.join(tmpDir(), 'config.json');
        await writeJsonAtomic(file, { baseUrl: 'https://api.example.com' });

        const cfg = await loadClientConfig(file);
        assert.deepEqual(cfg, { baseUrl: 'https://api.example.com' });
    });
});
