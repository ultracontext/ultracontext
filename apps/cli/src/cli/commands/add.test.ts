// =============================================================================
// add.test — RED. The `uc add` quick-capture verb: append a message (or create
// the cwd default context on first write). Sources: positional text | stdin |
// --json | --meta key=val. Flags: --role, --context <id>, --new.
// Local-first: it runs through a LocalContextClient against a TEMP sqlite db
// (UC_DB_URL override) so it never touches ~/.ultracontext.
// =============================================================================

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildAddCommand } from './add';
import { resolveClient } from '../../../lib/resolve-client';
import type { GetResult } from '../../../lib/context-client';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- harness ------------------------------------------------------------------

// a captured run: stdout/stderr text + the process exit code (0 when unset)
type RunResult = { stdout: string; stderr: string; code: number };

// per-test temp db + scoping cwd, wired through env so resolveClient picks them up
let dbUrl: string;
let cwd: string;
let savedEnv: { db?: string; dir?: string };

// point the CLI at a throwaway db + a unique cwd before each test
beforeEach(() => {
    dbUrl = tempDbUrl();
    cwd = '/work/add-' + Math.random().toString(36).slice(2);
    savedEnv = { db: process.env.UC_DB_URL, dir: process.env.UC_PROJECT_DIR };
    process.env.UC_DB_URL = dbUrl;
    process.env.UC_PROJECT_DIR = cwd;
});

// restore the environment so tests don't leak into each other
afterEach(() => {
    if (savedEnv.db === undefined) delete process.env.UC_DB_URL;
    else process.env.UC_DB_URL = savedEnv.db;
    if (savedEnv.dir === undefined) delete process.env.UC_PROJECT_DIR;
    else process.env.UC_PROJECT_DIR = savedEnv.dir;
});

// build the add command, capture its io streams, and parse the given args
async function runAdd(args: string[], stdin?: string): Promise<RunResult> {
    // capture buffers for the two data sinks
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        // force machine mode so output is deterministic JSON
        isTTY: false,
    };

    // record the exit code without killing the test process
    let code = 0;

    // an optional stdin payload exposed as an async iterable of one chunk
    const input = stdin === undefined ? undefined : (async function* () { yield stdin; })();

    // the command reads io/stdin/exit from an injected runtime context
    const command = buildAddCommand({ io, stdin: input, exit: (c?: number) => { code = c ?? 0; } });

    // commander prepends [node, script]; parse async so client IO can settle
    await command.parseAsync(['node', 'add', ...args]);

    return { stdout, stderr, code };
}

// read the context the add command wrote, straight through the client
async function readContext(): Promise<GetResult> {
    const client = await resolveClient({ dbUrl, cwd });
    const got = await client.get({});
    return got;
}

// -- happy path: positional quick-capture -------------------------------------

describe('uc add', () => {
    // a positional string creates the cwd default context + appends one message
    it('captures a positional message into the cwd default context', async () => {
        const { code } = await runAdd(['remember to ship the cli']);
        assert.equal(code, 0);

        // the message landed on the default context for this cwd
        const got = await readContext();
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'remember to ship the cli');
    });

    // -- happy path: stdin --------------------------------------------------------

    // with no positional, the message body is read from piped stdin
    it('captures from stdin when no positional is given', async () => {
        const { code } = await runAdd([], 'piped note body');
        assert.equal(code, 0);

        const got = await readContext();
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'piped note body');
    });

    // -- role + metadata ----------------------------------------------------------

    // --role sets the message role; --meta key=val attaches metadata pairs
    it('applies --role and --meta key=val', async () => {
        const { code } = await runAdd(['hi', '--role', 'assistant', '--meta', 'src=cli', '--meta', 'pri=high']);
        assert.equal(code, 0);

        const got = await readContext();
        assert.equal(got.data[0].role, 'assistant');
        assert.equal(got.data[0].metadata.src, 'cli');
        assert.equal(got.data[0].metadata.pri, 'high');
    });

    // -- json output shape --------------------------------------------------------

    // machine mode emits a single JSON line carrying the appended view + version
    it('emits machine JSON describing the appended message', async () => {
        const { stdout, code } = await runAdd(['shape me', '--json']);
        assert.equal(code, 0);

        // exactly one JSON line on stdout, nothing extra
        const lines = stdout.trim().split('\n');
        assert.equal(lines.length, 1);

        // the envelope exposes the message data + the resulting version + the id
        const out = JSON.parse(lines[0]);
        assert.ok(Array.isArray(out.data), 'data is an array of message views');
        assert.equal(out.data[0].content, 'shape me');
        assert.equal(typeof out.data[0].id, 'string');
        assert.equal(typeof out.version, 'number');
        assert.equal(typeof out.id, 'string');
    });

    // -- raw json body ------------------------------------------------------------

    // --json <body> parses a full message object instead of wrapping a string
    it('parses a raw message object from --json <body>', async () => {
        const body = JSON.stringify({ role: 'user', content: 'structured', metadata: { k: 'v' } });
        const { code } = await runAdd(['--json', body]);
        assert.equal(code, 0);

        const got = await readContext();
        assert.equal(got.data[0].content, 'structured');
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[0].metadata.k, 'v');
    });

    // -- targeting + accumulation -------------------------------------------------

    // repeated adds accumulate on the same cwd default context
    it('accumulates repeated captures on the same default context', async () => {
        await runAdd(['one']);
        await runAdd(['two']);

        const got = await readContext();
        assert.equal(got.data.length, 2);
        assert.equal(got.data[1].content, 'two');
    });

    // --context <id> targets an explicit context instead of the default
    it('appends to an explicit --context <id>', async () => {
        // seed a separate context directly through the client
        const client = await resolveClient({ dbUrl, cwd });
        const seeded = await client.add({ messages: [{ role: 'user', content: 'seed' }] });
        const targetId = (seeded.data[0] as { context_id?: string }).context_id
            ?? (await client.list({})).data[0].id;

        await runAdd(['targeted', '--context', targetId]);

        // the explicit context now holds both messages
        const got = await client.get({ id: targetId });
        assert.equal(got.data.length, 2);
        assert.equal(got.data[1].content, 'targeted');
    });

    // --new forces a brand-new context even when a default already exists
    it('--new forces a fresh context', async () => {
        await runAdd(['first']);
        await runAdd(['second', '--new']);

        // two distinct contexts now exist under this cwd's project
        const client = await resolveClient({ dbUrl, cwd });
        const listed = await client.list({});
        assert.ok(listed.data.length >= 2, 'a second context was created');
    });

    // -- error case ---------------------------------------------------------------

    // no positional, no stdin, no --json → invalid input, non-zero exit + stderr
    it('errors when there is no message to capture', async () => {
        const { code, stderr, stdout } = await runAdd([]);
        assert.notEqual(code, 0);
        assert.equal(stdout.trim(), '', 'no data written on error');
        assert.match(stderr, /\S/, 'an error is reported on stderr');
    });
});
