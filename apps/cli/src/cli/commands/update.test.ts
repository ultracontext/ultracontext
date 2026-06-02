// =============================================================================
// update.test — RED. `uc update` patches message(s) in a context (by id or
// index) with optional --meta, local-first through the ContextClient against a
// TEMP sqlite db (dbUrl override → never touches ~/.ultracontext). Asserts the
// patch lands (read-back via get), the --json output shape, and a key error.
// =============================================================================

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Command } from '@commander-js/extra-typings';

import { runUpdate, buildUpdateCommand } from './update';
import { resolveClient } from '../../../lib/resolve-client';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- capture sink -------------------------------------------------------------

// a writable that records everything written, for stdout/stderr assertions
function sink() {
    let text = '';
    return { write: (s: string) => ((text += s), true), get text() { return text; } };
}

// non-tty io so emit() chooses machine JSON on stdout (pipe-aware default)
function pipedIo() {
    return { stdout: sink(), stderr: sink(), isTTY: false };
}

// seed a context with one message via the local client, returning its id
async function seed(dbUrl: string, cwd: string, content: string): Promise<string> {
    const client = await resolveClient({ dbUrl, cwd });
    const ctx = await client.create({});
    await client.append({ id: ctx.id, messages: [{ role: 'user', content }] });
    return ctx.id;
}

// read the context's messages back via the local client
async function readBack(dbUrl: string, cwd: string, id: string) {
    const client = await resolveClient({ dbUrl, cwd });
    return (await client.get({ id })).data;
}

// -- happy path: patch by index ----------------------------------------------

describe('runUpdate', () => {
    // updating index 0 rewrites that message and the change persists locally
    it('patches a message by index in an explicit context', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-index';
        const id = await seed(dbUrl, cwd, 'old');

        const io = pipedIo();
        const code = await runUpdate(
            { context: id, index: 0, content: 'new', json: true },
            { dbUrl, cwd, io },
        );

        // success exit + the patch is observable through the ContextClient
        assert.equal(code, 0);
        const messages = await readBack(dbUrl, cwd, id);
        assert.equal(messages[0].content, 'new');
    });

    // -- --json output shape --------------------------------------------------

    // machine mode emits one JSON line on stdout: updated views + new version
    it('emits the updated views + version as JSON on stdout', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-json';
        const id = await seed(dbUrl, cwd, 'first');

        const io = pipedIo();
        const code = await runUpdate(
            { context: id, index: 0, content: 'second', json: true },
            { dbUrl, cwd, io },
        );

        // success, nothing on stderr, parseable JSON envelope on stdout
        assert.equal(code, 0);
        assert.equal(io.stderr.text, '');

        const payload = JSON.parse(io.stdout.text.trim());
        assert.ok(Array.isArray(payload.data), 'data is an array of message views');
        assert.equal(payload.data[0].content, 'second');
        assert.equal(payload.version, 1);
    });

    // -- --meta ---------------------------------------------------------------

    // --meta attaches version metadata to the update without erroring
    it('accepts --meta on the update', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-meta';
        const id = await seed(dbUrl, cwd, 'x');

        const io = pipedIo();
        const code = await runUpdate(
            { context: id, index: 0, content: 'y', meta: { note: 'edited' }, json: true },
            { dbUrl, cwd, io },
        );

        assert.equal(code, 0);
    });

    // -- error case: ambiguous selector --------------------------------------

    // specifying both id and index is rejected (invalid_input) → exit 1, no data
    it('errors when both id and index are given', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-ambiguous';
        await seed(dbUrl, cwd, 'z');

        const io = pipedIo();
        const code = await runUpdate(
            { id: 'msg_whatever', index: 0, content: 'q', json: true },
            { dbUrl, cwd, io },
        );

        // failure exit, error surfaced on stderr, no data line on stdout
        assert.equal(code, 1);
        assert.match(io.stderr.text, /both id and index/i);
        assert.equal(io.stdout.text, '');
    });
});

// -- positional id + $UC_CONTEXT (command factory) ----------------------------

// these drive the built Command so the positional <id> + env fallback are wired
describe('uc update <id>', () => {
    // restore env between cases so UC_CONTEXT never leaks across tests
    let saved: { db?: string; ctx?: string };
    beforeEach(() => { saved = { db: process.env.UC_DB_URL, ctx: process.env.UC_CONTEXT }; delete process.env.UC_CONTEXT; });
    afterEach(() => {
        if (saved.db === undefined) delete process.env.UC_DB_URL; else process.env.UC_DB_URL = saved.db;
        if (saved.ctx === undefined) delete process.env.UC_CONTEXT; else process.env.UC_CONTEXT = saved.ctx;
    });

    // wrap the verb in a root carrying the global --json, the way main.ts wires
    // it (update no longer has a local --json — it relies on the root global)
    function program(): Command {
        const root = new Command('uc');
        root.option('--json');
        root.addCommand(buildUpdateCommand());
        return root;
    }

    // `uc update <id> --index 0 --content new` patches via the positional id
    it('patches via a positional context id', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-positional';
        process.env.UC_DB_URL = dbUrl;
        const id = await seed(dbUrl, cwd, 'old');

        // drive the real command via the root's global --json (machine mode)
        await program().parseAsync(['node', 'uc', '--json', 'update', id, '--index', '0', '--content', 'new']);

        const messages = await readBack(dbUrl, cwd, id);
        assert.equal(messages[0].content, 'new');
    });

    // surface consistency: update drops --context + its duplicate local --json
    // (the root global --json + positional/$UC_CONTEXT cover both, uniformly)
    it('does not register --context or a duplicate --json option', () => {
        const flags = buildUpdateCommand().options.map((o: { long?: string }) => o.long);
        assert.ok(!flags.includes('--context'), 'update must not carry --context');
        assert.ok(!flags.includes('--json'), 'update must not carry a local --json (use the root global)');
    });

    // with no positional id, $UC_CONTEXT supplies the target context
    it('falls back to $UC_CONTEXT for the target context', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-env';
        process.env.UC_DB_URL = dbUrl;
        const id = await seed(dbUrl, cwd, 'old');
        process.env.UC_CONTEXT = id;

        await program().parseAsync(['node', 'uc', '--json', 'update', '--index', '0', '--content', 'fromenv']);

        const messages = await readBack(dbUrl, cwd, id);
        assert.equal(messages[0].content, 'fromenv');
    });
});
