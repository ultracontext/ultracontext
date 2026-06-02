// =============================================================================
// append.test — RED. `uc append <id>` appends message(s) to an EXPLICIT context.
// The id is a required positional, resolved via requireContextId so $UC_CONTEXT
// works as a fallback. Body sources: positional text | stdin | --json full
// object. Flags: --role, --meta (MESSAGE metadata). Runs through a
// LocalContextClient against a TEMP sqlite db (UC_DB_URL override → never
// ~/.ultracontext). Covers: append <id>, $UC_CONTEXT fallback, the no-context
// error, --role/--meta, stdin, and the --json raw object.
// =============================================================================

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppendCommand } from './append';
import { resolveClient } from '../../../lib/resolve-client';
import type { GetResult } from '../../../lib/context-client';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- harness ------------------------------------------------------------------

// a captured run: stdout/stderr text + the exit code + the resolved context id
type RunResult = { stdout: string; stderr: string; code: number; id?: string };

// per-test temp db + scoping cwd, wired through env so resolveClient picks them up
let dbUrl: string;
let cwd: string;
let savedEnv: { db?: string; dir?: string; ctx?: string };

// point the CLI at a throwaway db + a unique cwd before each test
beforeEach(() => {
    dbUrl = tempDbUrl();
    cwd = '/work/append-' + Math.random().toString(36).slice(2);
    savedEnv = { db: process.env.UC_DB_URL, dir: process.env.UC_PROJECT_DIR, ctx: process.env.UC_CONTEXT };
    process.env.UC_DB_URL = dbUrl;
    process.env.UC_PROJECT_DIR = cwd;
    delete process.env.UC_CONTEXT;
});

// restore the environment so tests don't leak into each other
afterEach(() => {
    if (savedEnv.db === undefined) delete process.env.UC_DB_URL;
    else process.env.UC_DB_URL = savedEnv.db;
    if (savedEnv.dir === undefined) delete process.env.UC_PROJECT_DIR;
    else process.env.UC_PROJECT_DIR = savedEnv.dir;
    if (savedEnv.ctx === undefined) delete process.env.UC_CONTEXT;
    else process.env.UC_CONTEXT = savedEnv.ctx;
});

// build the append command, capture its io streams, and parse the given args.
// machine mode forced on so stdout is a single JSON line carrying the context id.
async function runAppend(args: string[], stdin?: string): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        isTTY: false,
    };

    // record the exit code without killing the test process
    let code = 0;

    // an optional stdin payload exposed as an async iterable of one chunk
    const input = stdin === undefined ? undefined : (async function* () { yield stdin; })();

    // force --json so the resolved context id is surfaced on stdout
    const withJson = args.includes('--json') ? args : [...args, '--json'];
    const command = buildAppendCommand({ io, stdin: input, exit: (c?: number) => { code = c ?? 0; } });
    await command.parseAsync(['node', 'append', ...withJson]);

    // pull the resolved context id off the JSON envelope (when one was emitted)
    let id: string | undefined;
    try { id = JSON.parse(stdout.trim()).id; } catch { /* error runs have no envelope */ }

    return { stdout, stderr, code, id };
}

// seed a fresh context through the client and return its id
async function seedContext(): Promise<string> {
    const client = await resolveClient({ dbUrl, cwd });
    return (await client.create({})).id;
}

// read a context back by its explicit id, through the client
async function readContext(id: string): Promise<GetResult> {
    const client = await resolveClient({ dbUrl, cwd });
    return client.get({ id });
}

// -- happy path: explicit id positional ---------------------------------------

describe('uc append', () => {
    // `append <id> <text>` lands the message on the targeted context
    it('appends a positional message to an explicit context id', async () => {
        const id = await seedContext();
        const { code } = await runAppend([id, 'remember to ship the cli']);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'remember to ship the cli');
    });

    // -- stdin ----------------------------------------------------------------

    // with no positional text, the body is read from piped stdin
    it('appends from stdin when only the id is given', async () => {
        const id = await seedContext();
        const { code } = await runAppend([id], 'piped note body');
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'piped note body');
    });

    // -- role + metadata ------------------------------------------------------

    // --role sets the message role; --meta key=val attaches MESSAGE metadata
    it('applies --role and --meta key=val to the message', async () => {
        const id = await seedContext();
        const { code } = await runAppend([id, 'hi', '--role', 'assistant', '--meta', 'src=cli', '--meta', 'pri=high']);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data[0].role, 'assistant');
        assert.equal(got.data[0].metadata.src, 'cli');
        assert.equal(got.data[0].metadata.pri, 'high');
    });

    // -- raw json body --------------------------------------------------------

    // --json <body> parses a full message object instead of wrapping a string
    it('parses a raw message object from --json <body>', async () => {
        const id = await seedContext();
        const body = JSON.stringify({ role: 'user', content: 'structured', metadata: { k: 'v' } });
        const { code } = await runAppend([id, '--json', body]);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data[0].content, 'structured');
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[0].metadata.k, 'v');
    });

    // -- json output shape ----------------------------------------------------

    // machine mode emits one JSON line carrying the appended view + version + id
    it('emits machine JSON describing the appended message', async () => {
        const id = await seedContext();
        const { stdout, code } = await runAppend([id, 'shape me', '--json']);
        assert.equal(code, 0);

        const lines = stdout.trim().split('\n');
        assert.equal(lines.length, 1);

        const out = JSON.parse(lines[0]);
        assert.ok(Array.isArray(out.data));
        assert.equal(out.data[0].content, 'shape me');
        assert.equal(out.id, id, 'the targeted context id rides the envelope');
    });

    // -- accumulation ---------------------------------------------------------

    // repeated appends to the same id accumulate on that context
    it('accumulates repeated appends on the same id', async () => {
        const id = await seedContext();
        await runAppend([id, 'one']);
        await runAppend([id, 'two']);

        const got = await readContext(id);
        assert.equal(got.data.length, 2);
        assert.equal(got.data[1].content, 'two');
    });

    // -- $UC_CONTEXT fallback -------------------------------------------------

    // with $UC_CONTEXT set, a LONE positional is the text — the id comes from env
    it('treats a lone positional as text when $UC_CONTEXT supplies the id', async () => {
        const id = await seedContext();
        process.env.UC_CONTEXT = id;

        const { code } = await runAppend(['quick env note']);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'quick env note');
    });

    // $UC_CONTEXT also backs a stdin-piped body when no positional is present
    it('falls back to $UC_CONTEXT with a stdin body', async () => {
        const id = await seedContext();
        process.env.UC_CONTEXT = id;

        const { code } = await runAppend([], 'from env via stdin');
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'from env via stdin');
    });

    // an explicit <id> still wins over $UC_CONTEXT when BOTH positionals are given
    it('honors an explicit <id> <text> even when $UC_CONTEXT is set', async () => {
        const envCtx = await seedContext();
        const target = await seedContext();
        process.env.UC_CONTEXT = envCtx;

        const { code } = await runAppend([target, 'to the explicit id']);
        assert.equal(code, 0);

        // the explicit id got the message; the env context stayed empty
        const got = await readContext(target);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'to the explicit id');
        assert.equal((await readContext(envCtx)).data.length, 0);
    });

    // -- no-context error -----------------------------------------------------

    // no id positional and no $UC_CONTEXT → a clear error, non-zero exit.
    // body is piped so the failure is unambiguously the missing context id.
    it('errors when no context id is available', async () => {
        const { code, stdout, stderr } = await runAppend([], 'orphan text');
        assert.notEqual(code, 0);
        assert.equal(stdout.trim(), '', 'no data written on error');
        assert.match(stderr, /no context|UC_CONTEXT/i);
    });

    // -- missing body error ---------------------------------------------------

    // an id but no text/stdin/--json → invalid input, non-zero exit + stderr
    it('errors when there is no message body to append', async () => {
        const id = await seedContext();
        const { code, stdout, stderr } = await runAppend([id]);
        assert.notEqual(code, 0);
        assert.equal(stdout.trim(), '');
        assert.match(stderr, /\S/);
    });
});
