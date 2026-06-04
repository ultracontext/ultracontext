// =============================================================================
// create.test — RED. `uc create` makes a new context (or FORKS from --from),
// optionally tagging it with --meta key=val, and prints the new id. Drives the
// handler against a TEMP sqlite db (dbUrl override → never ~/.ultracontext) and
// captures stdout/stderr/exit. Covers: prints an id, --from forks, --meta tags.
// =============================================================================

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Command } from '@commander-js/extra-typings';

import { runCreate, buildCreateCommand } from './create';
import { createLocalClient } from '../../../lib/clients/local';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';
import { buildProgram } from '../main';

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

    // --json still emits the full envelope (machine consumers want metadata)
    it('emits the full JSON envelope with --json', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-json-envelope';

        const cap = captureIo();
        const code = await runCreate({ json: true }, { dbUrl, cwd, io: cap.io });
        assert.equal(code, 0);

        // a parseable envelope carrying id + metadata + created_at
        const out = JSON.parse(cap.out().trim()) as { id: string; metadata: unknown; created_at: string };
        assert.ok(out.id.startsWith('ctx_'));
        assert.ok('metadata' in out && 'created_at' in out);
    });
});

// -- bare-id vs envelope output (argv, real command) --------------------------

// `id=$(uc create)` in a pipe must capture ONLY the bare id, not the JSON
// envelope. Drive the REAL command through argv (a root carrying the global
// --json + an io-injected create) so the human/json split is exercised
// end-to-end. `create` → bare id; `create --json` → full envelope.
describe('uc create output (argv)', () => {
    let saved: { db?: string; dir?: string };
    beforeEach(() => {
        saved = { db: process.env.UC_DB_URL, dir: process.env.UC_PROJECT_DIR };
    });
    afterEach(() => {
        if (saved.db === undefined) delete process.env.UC_DB_URL;
        else process.env.UC_DB_URL = saved.db;
        if (saved.dir === undefined) delete process.env.UC_PROJECT_DIR;
        else process.env.UC_PROJECT_DIR = saved.dir;
    });

    // run the built create command through argv with an injected, non-tty io
    async function driveCreate(args: string[]): Promise<string> {
        let stdout = '';
        const io = {
            stdout: { write: (s: string) => ((stdout += s), true) },
            stderr: { write: () => true },
            isTTY: false,
        };

        // a root carrying the global --json, the way buildProgram wires it
        const program = new Command('uc');
        program.option('--json');
        program.addCommand(buildCreateCommand({ io }));
        await program.parseAsync(['node', 'uc', ...args]);
        return stdout.trim();
    }

    // bare `create` in a pipe → exactly the id, no envelope (the $(…) pattern)
    it('prints the bare id on stdout (no --json)', async () => {
        const dbUrl = tempDbUrl();
        process.env.UC_DB_URL = dbUrl;
        process.env.UC_PROJECT_DIR = '/work/create-bare-argv';

        const printed = await driveCreate(['create']);
        assert.ok(printed.startsWith('ctx_'), `expected a bare id, got: ${printed}`);
        assert.ok(!printed.includes('{'), 'pipe mode emits the bare id, not JSON');
    });

    // `create --json` in a pipe → the full envelope (id + metadata + created_at)
    it('emits the JSON envelope with --json', async () => {
        const dbUrl = tempDbUrl();
        process.env.UC_DB_URL = dbUrl;
        process.env.UC_PROJECT_DIR = '/work/create-json-argv';

        const printed = await driveCreate(['--json', 'create']);
        const out = JSON.parse(printed) as { id: string; metadata: unknown; created_at: string };
        assert.ok(out.id.startsWith('ctx_'));
        assert.ok('metadata' in out && 'created_at' in out);
    });
});

// -- --from --version time-travel (argv, real program) ------------------------

// Drive `uc create --from <id> --version 0` through buildProgram(). The bug: the
// global .version() shadows --version, so the fork-at-version selector never
// reaches the handler. After the fix it forks from version 0's snapshot.
describe('uc create --from --version (argv)', () => {
    let saved: { db?: string; dir?: string };
    beforeEach(() => {
        saved = { db: process.env.UC_DB_URL, dir: process.env.UC_PROJECT_DIR };
    });
    afterEach(() => {
        if (saved.db === undefined) delete process.env.UC_DB_URL;
        else process.env.UC_DB_URL = saved.db;
        if (saved.dir === undefined) delete process.env.UC_PROJECT_DIR;
        else process.env.UC_PROJECT_DIR = saved.dir;
    });

    // redirect process.stdout.write to a sink (the verb writes live io)
    function patchStdout(sink: (s: string) => boolean): () => void {
        const original = process.stdout.write.bind(process.stdout);
        const originalIsTTY = process.stdout.isTTY;
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        process.stdout.write = ((chunk: string) => sink(String(chunk))) as typeof process.stdout.write;
        return () => {
            process.stdout.write = original;
            Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
        };
    }

    // forks the SOURCE at version 0 (the original message), not its latest state
    it('forks from a source at --version 0', async () => {
        const dbUrl = tempDbUrl();
        const cwd = '/work/create-from-version';
        process.env.UC_DB_URL = dbUrl;
        process.env.UC_PROJECT_DIR = cwd;

        // a source with two versions: v0 original, v1 mutated
        const client = await createLocalClient({ dbUrl, cwd });
        const source = await client.create({});
        await client.append({ id: source.id, messages: [{ role: 'user', content: 'v0' }] });
        await client.update({ id: source.id, updates: [{ index: 0, content: 'v1' }] });

        let stdout = '';
        const restore = patchStdout((s) => ((stdout += s), true));
        try {
            await buildProgram().parseAsync(['node', 'uc', '--json', 'context', 'create', '--from', source.id, '--version', '0']);
        } finally {
            restore();
        }

        // the fork carries v0's content (not the CLI version string, not v1)
        assert.doesNotMatch(stdout.trim(), /^\d+\.\d+\.\d+$/, 'must not print the CLI version string');
        const forkId = (JSON.parse(stdout.trim()) as { id: string }).id;
        const forked = await client.get({ id: forkId });
        assert.equal(forked.data[0].content, 'v0');
    });
});
