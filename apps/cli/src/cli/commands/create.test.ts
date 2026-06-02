// =============================================================================
// create.test — RED. `uc create` makes a new context (or FORKS from --from),
// optionally tagging it with --meta key=val, and prints the new id. Drives the
// handler against a TEMP sqlite db (dbUrl override → never ~/.ultracontext) and
// captures stdout/stderr/exit. Covers: prints an id, --from forks, --meta tags.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { runCreate } from './create';
import { createLocalClient } from '../../../lib/clients/local';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- io capture ---------------------------------------------------------------

// a buffer-backed sink so we can assert exactly what landed on stdout/stderr
function captureIo() {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        // pipe (non-tty) so output stays deterministic JSON unless asserted human
        isTTY: false,
    };
    return { io, out: () => stdout, err: () => stderr };
}

// -- prints an id -------------------------------------------------------------

describe('runCreate', () => {
    // a bare create makes a fresh context and surfaces its id on stdout
    it('creates a context and prints its id', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-bare';

        const cap = captureIo();
        const code = await runCreate({ json: true }, { dbUrl, cwd, io: cap.io });
        assert.equal(code, 0);

        // the id is real — reading it back through the client succeeds
        const out = JSON.parse(cap.out().trim()) as { id: string };
        assert.equal(typeof out.id, 'string');
        assert.ok(out.id.length > 0);

        const client = await createLocalClient({ dbUrl, cwd });
        const got = await client.get({ id: out.id });
        assert.equal(got.data.length, 0, 'a fresh context starts empty');
    });

    // -- fork from <id> -------------------------------------------------------

    // --from forks the source context, carrying its messages into a new id
    it('forks from a source context with --from', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-fork';

        // seed a source context with one message to fork from
        const client = await createLocalClient({ dbUrl, cwd });
        const source = await client.create({});
        await client.append({ id: source.id, messages: [{ role: 'user', content: 'seed' }] });

        const cap = captureIo();
        const code = await runCreate({ from: source.id, json: true }, { dbUrl, cwd, io: cap.io });
        assert.equal(code, 0);

        // the fork is a NEW id carrying the source's message
        const out = JSON.parse(cap.out().trim()) as { id: string };
        assert.notEqual(out.id, source.id, 'fork gets its own id');

        const forked = await client.get({ id: out.id });
        assert.equal(forked.data.length, 1);
        assert.equal(forked.data[0].content, 'seed');
    });

    // -- --meta tags the context ---------------------------------------------

    // --meta key=val attaches metadata to the created CONTEXT (not a message)
    it('tags the context with --meta key=val', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-meta';

        const cap = captureIo();
        const code = await runCreate(
            { meta: { project: 'uc', pri: 'high' }, json: true },
            { dbUrl, cwd, io: cap.io },
        );
        assert.equal(code, 0);

        // the create envelope carries the context metadata back
        const out = JSON.parse(cap.out().trim()) as { id: string; metadata: Record<string, unknown> };
        assert.equal(out.metadata.project, 'uc');
        assert.equal(out.metadata.pri, 'high');
    });

    // -- human output --------------------------------------------------------

    // in human mode the bare id is printed (so `id=$(uc create)` works in shells)
    it('prints just the id in human mode', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-human';

        const cap = captureIo();
        cap.io.isTTY = true;
        const code = await runCreate({}, { dbUrl, cwd, io: cap.io });
        assert.equal(code, 0);

        // the whole stdout line is the id, nothing else
        const printed = cap.out().trim();
        assert.ok(printed.length > 0);
        assert.ok(!printed.includes('{'), 'human mode is the bare id, not JSON');
    });
});
