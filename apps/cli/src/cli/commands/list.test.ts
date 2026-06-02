// =============================================================================
// list.test — `uc list` lists a project's contexts via the local-first
// ContextClient. Filters: --source --project_path --limit. Defaults to the
// current project (cwd). Exercised against a TEMP SQLite db (db path injected
// so it never touches ~/.ultracontext); stdout + exit code are captured.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@commander-js/extra-typings';

import { listAction, registerList } from './list';
import { resolveClient } from '../../../lib/resolve-client';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- capture helper -----------------------------------------------------------

// a writable-like sink that records everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// seed two contexts into a temp db with distinct project_path/source metadata
async function seedDb(): Promise<string> {
    const url = tempDbUrl();
    const client = await resolveClient({ dbUrl: url, cwd: '/unused' });

    // context A — tagged with a project_path + a capture source
    const a = await client.create({ metadata: { project_path: '/work/list-a', source: 'claude-code' } });
    await client.append({ id: a.id, messages: [{ role: 'user', content: 'a1' }] });

    // context B — a different project_path, no source
    const b = await client.create({ metadata: { project_path: '/work/list-b' } });
    await client.append({ id: b.id, messages: [{ role: 'user', content: 'b1' }] });

    return url;
}

// -- happy path: defaults to the current project (cwd) ------------------------

describe('uc list', () => {
    // with no filters, list returns ALL contexts (no cwd default)
    it('lists all contexts by default', async () => {
        const url = await seedDb();
        const out = sink();
        const errs = sink();

        const code = await listAction(
            {},
            { dbUrl: url, cwd: '/unused', io: { stdout: out, stderr: errs, isTTY: false } },
        );

        assert.equal(code, 0);

        const payload = JSON.parse(out.text());
        assert.equal(payload.data.length, 2, 'both seeded contexts are listed');
    });

    // -- --json output shape --------------------------------------------------

    // machine mode emits one JSON line on stdout shaped { data: [{ id, metadata, created_at }] }
    it('emits the documented JSON shape with --json', async () => {
        const url = await seedDb();
        const out = sink();
        const errs = sink();

        const code = await listAction(
            { json: true },
            { dbUrl: url, cwd: '/work/list-a', io: { stdout: out, stderr: errs, isTTY: true } },
        );

        assert.equal(code, 0);

        // exactly one JSON line, no human noise on stderr
        const text = out.text();
        assert.equal(text.trim().split('\n').length, 1);
        assert.equal(errs.text(), '');

        const payload = JSON.parse(text);
        assert.ok(Array.isArray(payload.data));
        const row = payload.data[0];
        assert.ok(typeof row.id === 'string');
        assert.ok(typeof row.metadata === 'object' && row.metadata !== null);
        assert.ok(typeof row.created_at === 'string');
    });

    // -- filters: --source / --project_path / --limit -------------------------

    // --source narrows to contexts tagged with that source
    it('filters by --source', async () => {
        const url = await seedDb();
        const out = sink();

        await listAction(
            { source: 'claude-code' },
            { dbUrl: url, cwd: '/work/list-a', io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        const payload = JSON.parse(out.text());
        assert.equal(payload.data.length, 1);
        assert.equal(payload.data[0].metadata.source, 'claude-code');
    });

    // --project_path narrows to contexts tagged with that path
    it('filters by --project_path', async () => {
        const url = await seedDb();
        const out = sink();

        // explicitly target B → only B's context comes back
        await listAction(
            { project_path: '/work/list-b' },
            { dbUrl: url, cwd: '/unused', io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        const payload = JSON.parse(out.text());
        assert.equal(payload.data.length, 1);
        assert.equal(payload.data[0].metadata.project_path, '/work/list-b');
    });

    // -- error case: --remote without credentials -----------------------------

    // remote with no api key → clean failure, exit 1, actionable error on stderr
    it('exits 1 with an error when --remote without an api key', async () => {
        const url = await seedDb();
        const out = sink();
        const errs = sink();

        const code = await listAction(
            { remote: true, json: true },
            { dbUrl: url, cwd: '/work/list-a', io: { stdout: out, stderr: errs, isTTY: true } },
        );

        assert.equal(code, 1);
        assert.equal(out.text(), '');
        assert.match(JSON.parse(errs.text()).error, /api key/i);
    });

    // -- Commander wiring -----------------------------------------------------

    // the command registers on a program with name `list` + its filter options
    it('registers `list` with --source/--project_path/--limit', () => {
        const program = new Command();
        registerList(program);

        const list = program.commands.find((c: { name(): string }) => c.name() === 'list');
        assert.ok(list, 'list command not registered');

        const flags = list.options.map((o: { long?: string }) => o.long);
        assert.ok(flags.includes('--source'));
        assert.ok(flags.includes('--project_path'));
        assert.ok(flags.includes('--limit'));
    });
});
