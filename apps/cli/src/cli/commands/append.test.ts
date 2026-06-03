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

import { Command } from '@commander-js/extra-typings';

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

// build the append command UNDER a root carrying the global --json (the real
// wiring), capture its io, and parse the given args. io is forced non-tty so
// machine mode is on and stdout is a single JSON line carrying the context id.
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

    // a stdin payload exposed as an async iterable; an EMPTY iterable when none
    // (never undefined — that would let the command read the real process.stdin
    // and block the test waiting for input)
    const input = stdin === undefined
        ? (async function* (): AsyncGenerator<string> { /* no chunks */ })()
        : (async function* () { yield stdin; })();

    // a root with the global boolean --json + the real append command (so any
    // explicit --json in args resolves to the global, not a local option)
    const root = new Command('uc');
    root.option('--json');
    root.addCommand(buildAppendCommand({ io, stdin: input, exit: (c?: number) => { code = c ?? 0; } }));
    await root.parseAsync(['node', 'uc', 'append', ...args]);

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

    // -- raw message-object body ----------------------------------------------

    // --message <json> parses a full message object instead of wrapping a string
    it('parses a raw message object from --message <json>', async () => {
        const id = await seedContext();
        const body = JSON.stringify({ role: 'user', content: 'structured', metadata: { k: 'v' } });
        const { code } = await runAppend([id, '--message', body]);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data[0].content, 'structured');
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[0].metadata.k, 'v');
    });

    // -- --message JSON array → MANY messages, one version --------------------

    // a JSON ARRAY in --message spreads into MULTIPLE messages appended in ONE
    // call (one version bump) — NOT a single object with numeric keys "0","1".
    it('appends a --message JSON array as multiple messages in one version', async () => {
        const id = await seedContext();
        const body = JSON.stringify([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
        ]);
        const { stdout, code } = await runAppend([id, '--message', body]);
        assert.equal(code, 0);

        // both messages landed as distinct entries (no "0"/"1" numeric-key wrap)
        const got = await readContext(id);
        assert.equal(got.data.length, 2, 'array spread into two messages');
        assert.equal(got.data[0].content, 'first');
        assert.equal(got.data[1].content, 'second');
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[1].role, 'assistant');

        // both messages share ONE version (a single append call, not two)
        const out = JSON.parse(stdout.trim());
        assert.equal(out.data.length, 2, 'one envelope carries both messages');
        assert.equal(out.data[0].index, 0);
        assert.equal(out.data[1].index, 1);
        assert.equal(typeof out.version, 'number', 'a single version for the whole array');
    });

    // --meta applies to EVERY message of a --message array
    it('merges --meta into each message of a --message array', async () => {
        const id = await seedContext();
        const body = JSON.stringify([{ content: 'a' }, { content: 'b', metadata: { kept: 'yes' } }]);
        const { code } = await runAppend([id, '--message', body, '--meta', 'src=batch']);
        assert.equal(code, 0);

        const got = await readContext(id);
        // every message carries the --meta pair; existing message metadata is kept
        assert.equal(got.data[0].metadata.src, 'batch');
        assert.equal(got.data[1].metadata.src, 'batch');
        assert.equal(got.data[1].metadata.kept, 'yes');
    });

    // --message <json> merges --meta into the parsed message's metadata
    it('merges --meta into a --message <json> message metadata', async () => {
        const id = await seedContext();
        const body = JSON.stringify({ role: 'user', content: 'structured', metadata: { existing: 'kept' } });
        const { code } = await runAppend([id, '--message', body, '--meta', 'added=via-flag']);
        assert.equal(code, 0);

        const got = await readContext(id);
        // the body's own metadata is kept AND the --meta pair is merged in
        assert.equal(got.data[0].metadata.existing, 'kept');
        assert.equal(got.data[0].metadata.added, 'via-flag');
    });

    // -- json output shape ----------------------------------------------------

    // machine mode emits one JSON line carrying the appended view + version + id
    it('emits machine JSON describing the appended message', async () => {
        const id = await seedContext();
        // io is forced non-tty in the harness, so machine mode is already on
        const { stdout, code } = await runAppend([id, 'shape me']);
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

    // -- $UC_CONTEXT fallback (no lone-positional-as-text magic) --------------

    // FOOTGUN GUARD: with $UC_CONTEXT=A set, `append B` must NOT write B's id as
    // text into A. positional[0] is ALWAYS the context id — so B is the TARGET,
    // not a message body. With no body source, it errors (missing text), and A
    // is left untouched either way. This is the consistent, footgun-free rule.
    it('does not write a lone positional as text into $UC_CONTEXT (footgun guard)', async () => {
        const a = await seedContext();
        const b = await seedContext();
        process.env.UC_CONTEXT = a;

        // `UC_CONTEXT=A append B` — B is the id (no body) → error, nothing written
        const { code } = await runAppend([b]);
        assert.notEqual(code, 0, 'no body for the targeted id → error');

        // A (the env context) must be untouched — B was never its message text
        assert.equal((await readContext(a)).data.length, 0, '$UC_CONTEXT was not written into');
        // B (the real target) is also untouched — there was no body to append
        assert.equal((await readContext(b)).data.length, 0, 'no body means no append');
    });

    // $UC_CONTEXT supplies the id; the body comes from stdin (the canonical form)
    it('falls back to $UC_CONTEXT with a stdin body', async () => {
        const id = await seedContext();
        process.env.UC_CONTEXT = id;

        const { code } = await runAppend([], 'from env via stdin');
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'from env via stdin');
    });

    // $UC_CONTEXT supplies the id; the body comes from --message (a flag, not a positional)
    it('falls back to $UC_CONTEXT with a --message body', async () => {
        const id = await seedContext();
        process.env.UC_CONTEXT = id;

        const body = JSON.stringify({ role: 'user', content: 'from env via json' });
        const { code } = await runAppend(['--message', body]);
        assert.equal(code, 0);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'from env via json');
    });

    // an explicit <id> <text> still works and wins over $UC_CONTEXT
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

// -- under the root global --json (argv, real wiring) -------------------------

// The append command is registered under a root that carries a GLOBAL boolean
// --json (machine-output toggle). Those tests drive append THROUGH that root —
// the way the real program wires it — so the global --json can't shadow the
// body sources (a prior bug misread `--json <obj>` as positional text and never
// read piped stdin at all).
describe('uc append under the root --json', () => {
    // build a root with the global --json + the append command, injecting io +
    // stdin so the body sources are exercised under the real flag wiring. stdin
    // is always an iterable (EMPTY when none) so the command never reads the
    // real process.stdin and blocks the test.
    function rootWith(io: unknown, stdin?: string) {
        const input = stdin === undefined
            ? (async function* (): AsyncGenerator<string> { /* no chunks */ })()
            : (async function* () { yield stdin; })();
        const root = new Command('uc');
        root.option('--json');
        root.addCommand(
            buildAppendCommand({
                io: io as { stdout?: { write(s: string): boolean }; stderr?: { write(s: string): boolean }; isTTY?: boolean },
                stdin: input,
                exit: () => {},
            }),
        );
        return root;
    }

    // capture sink for the append's emitted io
    function makeIo() {
        let stdout = '';
        let stderr = '';
        return {
            io: {
                stdout: { write: (s: string) => ((stdout += s), true) },
                stderr: { write: (s: string) => ((stderr += s), true) },
                isTTY: false,
            },
            out: () => stdout,
            err: () => stderr,
        };
    }

    // explicit id + piped stdin lands the body (NOT swallowed by the global flag)
    it('reads a stdin body for an explicit id through the root', async () => {
        const id = await seedContext();
        const cap = makeIo();
        await rootWith(cap.io, 'piped through root').parseAsync(['node', 'uc', 'append', id]);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'piped through root');
    });

    // $UC_CONTEXT supplies the id + piped stdin supplies the body (canonical form)
    it('reads a stdin body with $UC_CONTEXT through the root', async () => {
        const id = await seedContext();
        process.env.UC_CONTEXT = id;
        const cap = makeIo();
        await rootWith(cap.io, 'env id + stdin body').parseAsync(['node', 'uc', 'append']);

        const got = await readContext(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'env id + stdin body');
    });

    // a raw object body must NOT be misread as positional text under the global
    // boolean --json — it must parse as a full message object
    it('parses a raw message-object body for an explicit id through the root', async () => {
        const id = await seedContext();
        const cap = makeIo();
        const body = JSON.stringify({ role: 'assistant', content: 'structured-body', metadata: { kept: 'yes' } });
        await rootWith(cap.io).parseAsync(['node', 'uc', 'append', id, '--message', body, '--meta', 'added=flag']);

        const got = await readContext(id);
        assert.equal(got.data[0].content, 'structured-body', 'parsed as an object, not raw text');
        assert.equal(got.data[0].role, 'assistant');
        // body metadata kept AND --meta merged in
        assert.equal(got.data[0].metadata.kept, 'yes');
        assert.equal(got.data[0].metadata.added, 'flag');
    });

    // FOOTGUN GUARD: `append <id> --json '{...}' --meta tag=y` — the global
    // boolean --json can't carry a value (Commander routes it to the root), so a
    // JSON-object positional under an explicit --json was silently stored as a
    // RAW STRING (no role parsed). Under --json a JSON-OBJECT positional is a
    // structured message: parse it, and merge --meta into its metadata.
    it('parses a JSON-object positional as a message when --json is set', async () => {
        const id = await seedContext();
        const cap = makeIo();
        // the exact shorthand the user reaches for: --json '<obj>'
        await rootWith(cap.io).parseAsync([
            'node', 'uc', '--json', 'append', id, '{"role":"user","content":"x"}', '--meta', 'tag=y',
        ]);

        const got = await readContext(id);
        // the object was PARSED (role + content), not stored as a raw JSON string
        assert.equal(got.data[0].content, 'x', 'JSON-object positional parsed, not raw text');
        assert.equal(got.data[0].role, 'user');
        // --meta still merges onto the parsed message's metadata
        assert.equal(got.data[0].metadata.tag, 'y');
    });

    // a NON-object positional under --json (a plain string, even machine output)
    // stays plain text — only a JSON OBJECT is treated as a structured message
    it('keeps a plain-string positional as text under --json', async () => {
        const id = await seedContext();
        const cap = makeIo();
        await rootWith(cap.io).parseAsync(['node', 'uc', '--json', 'append', id, 'just text']);

        const got = await readContext(id);
        assert.equal(got.data[0].content, 'just text', 'a plain string stays text');
        assert.equal(got.data[0].role, undefined);
    });

    // a JSON-object positional WITHOUT --json stays literal text — no surprise
    // parsing of content that merely looks like JSON when the user didn't opt in
    it('keeps a JSON-looking positional as text without --json', async () => {
        const id = await seedContext();
        const cap = makeIo();
        await rootWith(cap.io).parseAsync(['node', 'uc', 'append', id, '{"role":"user","content":"x"}']);

        const got = await readContext(id);
        assert.equal(got.data[0].content, '{"role":"user","content":"x"}', 'literal text, not parsed');
        assert.equal(got.data[0].role, undefined);
    });
});
