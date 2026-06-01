import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createContext, appendMessages, getContext } from '@ultracontext/core';
import { createSqliteAdapter } from './index';

// =============================================================================
// KEYSTONE PROOF — @ultracontext/core ops run against local SQLite, in-process,
// with NO HTTP server. This is the whole Full-TS-local-first thesis.
// =============================================================================

// unique temp db file per use, auto-cleaned (local-first stores a real file)
const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-sqlite-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
    tmpFiles.push(file);
    return `file:${file}`;
}
after(() => {
    for (const f of tmpFiles) {
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(f + ext); } catch { /* ignore */ }
        }
    }
});

describe('SqliteAdapter — core ops run local, no server', () => {
    it('round-trips create → append → get', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        const project = await storage.insertProject('test');
        const projectId = project!.id;

        // create a context
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;

        // append two messages
        const appended = await appendMessages(storage, projectId, created.data.id, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ]);
        assert.equal(appended.ok, true);
        if (!appended.ok) return;
        assert.equal(appended.data.data.length, 2);

        // read them back, ordered
        const got = await getContext(storage, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 2);
        assert.equal(got.data.data[0].role, 'user');
        assert.equal(got.data.data[1].role, 'assistant');
    });

    it('persists across reconnects to the same file (local-first, no server)', async () => {
        const url = tmpDbUrl();

        // write with one connection
        let storage = await createSqliteAdapter(url);
        const project = await storage.insertProject('test');
        const projectId = project!.id;
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;
        await appendMessages(storage, projectId, created.data.id, [{ role: 'user', content: 'persisted' }]);

        // reopen a fresh connection to the same file — data survives
        storage = await createSqliteAdapter(url);
        const got = await getContext(storage, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 1);
        assert.equal(got.data.data[0].content, 'persisted');
    });
});
