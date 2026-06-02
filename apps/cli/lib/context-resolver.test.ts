// =============================================================================
// context-resolver.test — resolve-or-create the default context for a cwd,
// against a real temp SQLite adapter (no server).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';
import { listContexts } from '@ultracontext/core';

import { ensureProject, resolveDefaultContext } from './context-resolver';
import { tempDbUrl, cleanupTempDbs } from './testing/temp-db';

after(cleanupTempDbs);

// -- project --------------------------------------------------------------

describe('ensureProject', () => {
    // first call creates the local project; second returns the same id
    it('is idempotent — same project id across calls', async () => {
        const storage = await createSqliteAdapter(tempDbUrl());

        const first = await ensureProject(storage);
        const second = await ensureProject(storage);

        assert.equal(typeof first, 'number');
        assert.equal(first, second);
    });
});

// -- default context ----------------------------------------------------------

describe('resolveDefaultContext', () => {
    // creates a context keyed by project_path when none exists yet
    it('creates a context tagged with the cwd on first call', async () => {
        const storage = await createSqliteAdapter(tempDbUrl());
        const projectId = await ensureProject(storage);

        const id = await resolveDefaultContext(storage, projectId, '/work/proj-a');
        assert.ok(id.startsWith('ctx_') || id.length > 0);

        // it is discoverable by its project_path filter
        const listed = await listContexts(storage, projectId, { project_path: '/work/proj-a', limit: 10 });
        assert.equal(listed.data.length, 1);
        assert.equal(listed.data[0].id, id);
        assert.equal(listed.data[0].metadata.project_path, '/work/proj-a');
    });

    // returns the existing context on subsequent calls for the same cwd
    it('is stable — returns the same id for the same cwd', async () => {
        const storage = await createSqliteAdapter(tempDbUrl());
        const projectId = await ensureProject(storage);

        const a = await resolveDefaultContext(storage, projectId, '/work/proj-b');
        const b = await resolveDefaultContext(storage, projectId, '/work/proj-b');
        assert.equal(a, b);

        // and only one context exists for that cwd
        const listed = await listContexts(storage, projectId, { project_path: '/work/proj-b', limit: 10 });
        assert.equal(listed.data.length, 1);
    });

    // different cwds get different default contexts
    it('scopes per cwd — distinct ids for distinct paths', async () => {
        const storage = await createSqliteAdapter(tempDbUrl());
        const projectId = await ensureProject(storage);

        const a = await resolveDefaultContext(storage, projectId, '/work/x');
        const b = await resolveDefaultContext(storage, projectId, '/work/y');
        assert.notEqual(a, b);
    });
});
