// =============================================================================
// auth.test — the serve bearer-key model over a real temp SQLite db. Covers:
// first run mints a raw key bound to the SAME 'local' project the CLI's context
// verbs use; a second run finds the existing key (no new mint, no raw key); a
// minted key verifies (resolving the local project id); a bad/absent token does
// not verify.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';
import { ensureProject } from '../context-resolver';

import { ensureServeKey, verifyBearer } from './auth';
import { tempDbUrl, cleanupTempDbs } from '../testing/temp-db';

// temp config dirs the serve-key prefix is remembered in (kept off real ~)
const tmpDirs: string[] = [];

after(() => {
    cleanupTempDbs();
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// a fresh temp config dir for the serve.json prefix
function freshConfigDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-serve-cfg-'));
    tmpDirs.push(dir);
    return dir;
}

// open a fresh temp adapter for one test
async function freshStorage() {
    return createSqliteAdapter(tempDbUrl());
}

// -- first run mint -----------------------------------------------------------

describe('ensureServeKey', () => {
    // a fresh db mints a raw key under the SAME 'local' project the CLI uses
    it('mints a raw key bound to the local project on first run', async () => {
        const storage = await freshStorage();

        const result = await ensureServeKey(storage, freshConfigDir());
        assert.equal(result.minted, true);
        assert.ok(result.key && result.key.startsWith('uc_'));

        // the key's project IS the CLI's local project (so authed ops resolve it)
        const localProjectId = await ensureProject(storage);
        assert.equal(result.projectId, localProjectId);
    });

    // a second run reuses the existing key — no new mint, no raw key surfaced
    it('finds the existing key on a second run (no re-mint)', async () => {
        const storage = await freshStorage();
        const configDir = freshConfigDir();

        const first = await ensureServeKey(storage, configDir);
        const second = await ensureServeKey(storage, configDir);

        assert.equal(first.minted, true);
        assert.equal(second.minted, false);
        assert.equal(second.key, undefined);
        assert.equal(second.projectId, first.projectId);
    });
});

// -- verify --------------------------------------------------------------------

describe('verifyBearer', () => {
    // a minted key verifies and resolves the local project id
    it('verifies a minted key to its project', async () => {
        const storage = await freshStorage();

        const minted = await ensureServeKey(storage, freshConfigDir());
        const verified = await verifyBearer(storage, minted.key!);

        assert.ok(verified);
        assert.equal(verified!.projectId, minted.projectId);
    });

    // a wrong token never verifies
    it('rejects a bad token', async () => {
        const storage = await freshStorage();
        await ensureServeKey(storage, freshConfigDir());

        const verified = await verifyBearer(storage, 'uc_live_totally_wrong');
        assert.equal(verified, null);
    });
});
