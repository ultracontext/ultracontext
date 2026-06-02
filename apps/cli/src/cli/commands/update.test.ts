// =============================================================================
// update.test — RED. `uc update` patches message(s) in a context (by id or
// index) with optional --meta, local-first through the ContextClient against a
// TEMP sqlite db (dbUrl override → never touches ~/.ultracontext). Asserts the
// patch lands (read-back via get), the --json output shape, and a key error.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { runUpdate } from './update';
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

// seed a default context (per cwd) with one message via the local client
async function seed(dbUrl: string, cwd: string, content: string) {
    const client = await resolveClient({ dbUrl, cwd });
    await client.add({ messages: [{ role: 'user', content }] });
}

// read the default context's messages back via the local client
async function readBack(dbUrl: string, cwd: string) {
    const client = await resolveClient({ dbUrl, cwd });
    return (await client.get({})).data;
}

// -- happy path: patch by index ----------------------------------------------

describe('runUpdate', () => {
    // updating index 0 rewrites that message and the change persists locally
    it('patches a message by index against the default context', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-index';
        await seed(dbUrl, cwd, 'old');

        const io = pipedIo();
        const code = await runUpdate(
            { index: 0, content: 'new', json: true },
            { dbUrl, cwd, io },
        );

        // success exit + the patch is observable through the ContextClient
        assert.equal(code, 0);
        const messages = await readBack(dbUrl, cwd);
        assert.equal(messages[0].content, 'new');
    });

    // -- --json output shape --------------------------------------------------

    // machine mode emits one JSON line on stdout: updated views + new version
    it('emits the updated views + version as JSON on stdout', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/update-json';
        await seed(dbUrl, cwd, 'first');

        const io = pipedIo();
        const code = await runUpdate(
            { index: 0, content: 'second', json: true },
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
        await seed(dbUrl, cwd, 'x');

        const io = pipedIo();
        const code = await runUpdate(
            { index: 0, content: 'y', meta: { note: 'edited' }, json: true },
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
