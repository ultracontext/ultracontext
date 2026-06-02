// =============================================================================
// get.test (RED) — `uc get` reads a context local-first through a ContextClient.
// Seeds a TEMP SQLite db (dbUrl override → never touches ~/.ultracontext),
// then invokes the not-yet-existing handler with injectable io + cwd + dbUrl.
// Covers: happy path, --json output shape, and a not-found error case.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalClient } from '../../../lib/clients/local';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

// the command under test — does not exist yet, so import makes this RED
import { runGet } from './get';

after(cleanupTempDbs);

// -- io capture ---------------------------------------------------------------

// a fake stdout/stderr pair so we can assert what the handler wrote where
function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        // injectable io for the output helpers — force machine-mode-off via isTTY
        io: {
            stdout: { write: (s: string) => (out.push(s), true) },
            stderr: { write: (s: string) => (err.push(s), true) },
            isTTY: true,
        },
    };
}

// -- fixtures -----------------------------------------------------------------

// seed a fresh temp db with a default context for `cwd`, returning its url + id
async function seed(cwd: string, messages: Array<Record<string, unknown>>) {
    const dbUrl = tempDbUrl();

    // write through the same local client the command resolves under the hood
    const client = await createLocalClient({ dbUrl, cwd });
    await client.add({ messages });

    // discover the created default context id via the listing
    const listed = await client.list({ project_path: cwd });
    return { dbUrl, id: listed.data[0].id };
}

// -- happy path ---------------------------------------------------------------

describe('runGet', () => {
    // default cwd context → reads its messages back, exits 0, writes to stdout
    it('reads the default cwd context', async () => {
        const cwd = '/work/get-default';
        const { dbUrl } = await seed(cwd, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ]);

        const { out, err, io } = captureIo();
        const code = await runGet({}, { dbUrl, cwd, io });

        // success exit + the messages surfaced on stdout (not stderr)
        assert.equal(code, 0);
        assert.equal(err.length, 0);
        assert.ok(out.join('').includes('hello'));
    });

    // an explicit --context id reads that context regardless of cwd
    it('reads an explicit --context id', async () => {
        const cwd = '/work/get-explicit';
        const { dbUrl, id } = await seed(cwd, [{ role: 'user', content: 'pinned' }]);

        const { out, io } = captureIo();
        const code = await runGet({ context: id }, { dbUrl, cwd: '/work/somewhere-else', io });

        assert.equal(code, 0);
        assert.ok(out.join('').includes('pinned'));
    });

    // -- --json output shape --------------------------------------------------

    // --json emits one parseable JSON line with the { data, version } envelope
    it('emits a JSON envelope with --json', async () => {
        const cwd = '/work/get-json';
        const { dbUrl } = await seed(cwd, [{ role: 'user', content: 'structured' }]);

        const { out, io } = captureIo();
        const code = await runGet({ json: true }, { dbUrl, cwd, io });

        assert.equal(code, 0);

        // the whole stdout is a single JSON line we can parse
        const parsed = JSON.parse(out.join('').trim()) as { data: unknown[]; version: number };
        assert.ok(Array.isArray(parsed.data));
        assert.equal(parsed.data.length, 1);
        assert.equal(typeof parsed.version, 'number');
    });

    // -- error case -----------------------------------------------------------

    // a non-existent explicit id fails: exit 1, message on stderr, stdout clean
    it('fails with exit 1 on a non-existent context id', async () => {
        const cwd = '/work/get-missing';
        const { dbUrl } = await seed(cwd, [{ role: 'user', content: 'present' }]);

        const { out, err, io } = captureIo();
        const code = await runGet({ context: 'ctx_does_not_exist' }, { dbUrl, cwd, io });

        assert.equal(code, 1);
        assert.equal(out.length, 0);
        assert.ok(err.join('').length > 0);
    });
});
