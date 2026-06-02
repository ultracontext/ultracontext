// =============================================================================
// config.test — ~/.ultracontext paths (no XDG) + atomic write round-trips.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { configDir, configPath, dbUrl, projectDir, writeJsonAtomic, readJson } from './config';

// -- temp dir cleanup ---------------------------------------------------------

const tmpDirs: string[] = [];
function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-config-'));
    tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// -- path resolution ----------------------------------------------------------

describe('config paths', () => {
    // root dir is ~/.ultracontext — never an XDG path
    it('resolves ~/.ultracontext (not XDG)', () => {
        assert.equal(configDir(), path.join(os.homedir(), '.ultracontext'));
        assert.ok(!configDir().includes('.config'));
    });

    // config json sits inside the root dir
    it('resolves config.json under the root dir', () => {
        assert.equal(configPath(), path.join(configDir(), 'config.json'));
    });

    // db url is a libsql file: url pointing at uc.db in the root dir
    it('resolves the local db url', () => {
        const prev = process.env.UC_DB_URL;
        delete process.env.UC_DB_URL;
        try {
            assert.equal(dbUrl(), 'file:' + path.join(configDir(), 'uc.db'));
        } finally {
            if (prev !== undefined) process.env.UC_DB_URL = prev;
        }
    });

    // UC_DB_URL overrides the default db location (env-aware resolution)
    it('honors UC_DB_URL over the default db url', () => {
        const prev = process.env.UC_DB_URL;
        process.env.UC_DB_URL = 'file:/tmp/override.db';
        try {
            assert.equal(dbUrl(), 'file:/tmp/override.db');
        } finally {
            if (prev === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = prev;
        }
    });

    // projectDir defaults to cwd, but UC_PROJECT_DIR overrides it
    it('resolves the project dir (UC_PROJECT_DIR over cwd)', () => {
        const prev = process.env.UC_PROJECT_DIR;
        delete process.env.UC_PROJECT_DIR;
        try {
            assert.equal(projectDir(), process.cwd());
            process.env.UC_PROJECT_DIR = '/work/scope';
            assert.equal(projectDir(), '/work/scope');
        } finally {
            if (prev === undefined) delete process.env.UC_PROJECT_DIR;
            else process.env.UC_PROJECT_DIR = prev;
        }
    });
});

// -- atomic write -------------------------------------------------------------

describe('writeJsonAtomic', () => {
    // write → read round-trips, and no .tmp sibling is left behind
    it('round-trips JSON and leaves no temp files', async () => {
        const dir = tmpDir();
        const target = path.join(dir, 'config.json');

        await writeJsonAtomic(target, { agent: 'claude', remote: false });
        const back = await readJson<{ agent: string; remote: boolean }>(target);

        assert.deepEqual(back, { agent: 'claude', remote: false });
        const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
        assert.equal(leftovers.length, 0);
    });

    // creates missing parent directories on the way
    it('creates missing parent dirs', async () => {
        const dir = tmpDir();
        const target = path.join(dir, 'nested', 'deep', 'config.json');

        await writeJsonAtomic(target, { ok: true });
        assert.ok(fs.existsSync(target));
    });

    // readJson returns null for a missing file (callers fall back to defaults)
    it('readJson returns null when the file is absent', async () => {
        const dir = tmpDir();
        const back = await readJson(path.join(dir, 'missing.json'));
        assert.equal(back, null);
    });
});
