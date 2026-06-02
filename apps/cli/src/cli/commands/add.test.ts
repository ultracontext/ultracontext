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

// build the add command, capture its io streams, and parse the given args.
// machine mode forced on so stdout is a single JSON line carrying the context id.
async function runAdd(args: string[], stdin?: string): Promise<RunResult & { id?: string }> {
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

    // force --json (unless already present) so the resolved context id is
    // surfaced on stdout for round-trip reads
    const withJson = args.includes('--json') ? args : [...args, '--json'];
    const command = buildAddCommand({ io, stdin: input, exit: (c?: number) => { code = c ?? 0; } });
    await command.parseAsync(['node', 'add', ...withJson]);

    // pull the resolved context id off the JSON envelope (when one was emitted)
    let id: string | undefined;
    try { id = JSON.parse(stdout.trim()).id; } catch { /* error runs have no envelope */ }

    return { stdout, stderr, code, id };
}

// read a context the add command wrote, by its explicit id, through the client
async function readContext(id: string): Promise<GetResult> {
    const client = await resolveClient({ dbUrl, cwd });
    return client.get({ id });
}

// -- happy path: positional quick-capture -------------------------------------

describe('uc add', () => {
    // a positional string creates a fresh context + appends one message
    it('captures a positional message into a fresh context', async () => {
        const { code, id } = await runAdd(['remember to ship the cli']);
        assert.equal(code, 0);

        // the message landed on the freshly-created context
        const got = await readContext(id!);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'remember to ship the cli');
    });

    // -- happy path: stdin --------------------------------------------------------

    // with no positional, the message body is read from piped stdin
    it('captures from stdin when no positional is given', async () => {
        const { code, id } = await runAdd([], 'piped note body');
        assert.equal(code, 0);

        const got = await readContext(id!);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'piped note body');
    });

    // -- role + metadata ----------------------------------------------------------

    // --role sets the message role; --meta key=val attaches metadata pairs
    it('applies --role and --meta key=val', async () => {
        const { code, id } = await runAdd(['hi', '--role', 'assistant', '--meta', 'src=cli', '--meta', 'pri=high']);
        assert.equal(code, 0);

        const got = await readContext(id!);
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
        assert.ok(out.id.length > 0, 'the resolved context id is non-empty');
    });

    // -- raw json body ------------------------------------------------------------

    // --json <body> parses a full message object instead of wrapping a string
    it('parses a raw message object from --json <body>', async () => {
        const body = JSON.stringify({ role: 'user', content: 'structured', metadata: { k: 'v' } });
        const { code, id } = await runAdd(['--json', body]);
        assert.equal(code, 0);

        const got = await readContext(id!);
        assert.equal(got.data[0].content, 'structured');
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[0].metadata.k, 'v');
    });

    // -- targeting + accumulation -------------------------------------------------

    // repeated adds targeting the SAME --context accumulate on it
    it('accumulates repeated captures on an explicit context', async () => {
        const first = await runAdd(['one']);
        await runAdd(['two', '--context', first.id!]);

        const got = await readContext(first.id!);
        assert.equal(got.data.length, 2);
        assert.equal(got.data[1].content, 'two');
    });

    // --context <id> targets an explicit context
    it('appends to an explicit --context <id>', async () => {
        // seed a separate context directly through the client
        const client = await resolveClient({ dbUrl, cwd });
        const seeded = await client.create({});
        await client.append({ id: seeded.id, messages: [{ role: 'user', content: 'seed' }] });

        await runAdd(['targeted', '--context', seeded.id]);

        // the explicit context now holds both messages
        const got = await client.get({ id: seeded.id });
        assert.equal(got.data.length, 2);
        assert.equal(got.data[1].content, 'targeted');
    });

    // each id-less add creates a distinct fresh context (no default to reuse)
    it('creates a distinct context per id-less capture', async () => {
        const first = await runAdd(['first']);
        const second = await runAdd(['second']);

        assert.notEqual(first.id, second.id, 'each capture gets its own context');
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
