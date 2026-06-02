// =============================================================================
// get.test (RED) — `uc get` reads a context local-first through a ContextClient.
// Seeds a TEMP SQLite db (dbUrl override → never touches ~/.ultracontext),
// then invokes the not-yet-existing handler with injectable io + cwd + dbUrl.
// Covers: happy path, --json output shape, and a not-found error case.
// =============================================================================

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalClient } from '../../../lib/clients/local';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';
import { buildProgram } from '../main';

// the command under test — does not exist yet, so import makes this RED
import { runGet, buildGetCommand } from './get';

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

// seed a fresh temp db with a context, returning its url + id (no cwd default)
async function seed(cwd: string, messages: Array<Record<string, unknown>>) {
    const dbUrl = tempDbUrl();

    // write through the same local client the command resolves under the hood
    const client = await createLocalClient({ dbUrl, cwd });
    const ctx = await client.create({});
    await client.append({ id: ctx.id, messages });
    return { dbUrl, id: ctx.id };
}

// -- happy path ---------------------------------------------------------------

describe('runGet', () => {
    // an explicit context id reads its messages back, exits 0, writes to stdout
    it('reads an explicit context id', async () => {
        const cwd = '/work/get-default';
        const { dbUrl, id } = await seed(cwd, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ]);

        const { out, err, io } = captureIo();
        const code = await runGet({ context: id }, { dbUrl, cwd, io });

        // success exit + the messages surfaced on stdout (not stderr)
        assert.equal(code, 0);
        assert.equal(err.length, 0);
        assert.ok(out.join('').includes('hello'));
    });

    // a resolved explicit id reads that context regardless of cwd
    it('reads a resolved explicit id regardless of cwd', async () => {
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
        const { dbUrl, id } = await seed(cwd, [{ role: 'user', content: 'structured' }]);

        const { out, io } = captureIo();
        const code = await runGet({ context: id, json: true }, { dbUrl, cwd, io });

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

// -- --version time-travel (argv-level, real program) -------------------------

// Drive `uc get <id> --version 0` through the REAL buildProgram(). The bug: the
// root program registers Commander's global .version(), which intercepts
// `--version` on subcommands and prints the CLI version string instead of
// reading context version 0. This must time-travel to v0's DATA instead.
describe('uc get --version (argv)', () => {
    // scope the whole program at a throwaway db via env, restore afterwards
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

    // temporarily redirect process.stdout.write to a sink (get writes live io)
    function patchStdout(sink: (s: string) => boolean): () => void {
        const original = process.stdout.write.bind(process.stdout);
        const originalIsTTY = process.stdout.isTTY;
        // machine mode keys off isTTY=false, so force it for deterministic JSON
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        process.stdout.write = ((chunk: string) => sink(String(chunk))) as typeof process.stdout.write;
        return () => {
            process.stdout.write = original;
            Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
        };
    }

    // surface consistency: get drops --context (positional + $UC_CONTEXT is enough,
    // and uniform across all four targeted verbs)
    it('does not register a --context option', () => {
        const flags = buildGetCommand().options.map((o: { long?: string }) => o.long);
        assert.ok(!flags.includes('--context'), 'get must not carry --context');
    });

    // `get <id> --version 0` returns version 0's messages (NOT the CLI version)
    it('reads version 0 data instead of printing the CLI version string', async () => {
        const cwd = '/work/get-version-argv';
        const dbUrl = tempDbUrl();
        process.env.UC_DB_URL = dbUrl;
        process.env.UC_PROJECT_DIR = cwd;

        // seed two versions: v0 has the original message, v1 mutates it
        const client = await createLocalClient({ dbUrl, cwd });
        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ role: 'user', content: 'v0-content' }] });
        await client.update({ id: ctx.id, updates: [{ index: 0, content: 'v1-content' }] });

        // drive the REAL program through argv
        let stdout = '';
        const restore = patchStdout((s) => ((stdout += s), true));
        try {
            await buildProgram().parseAsync(['node', 'uc', '--json', 'get', ctx.id, '--version', '0']);
        } finally {
            restore();
        }

        // must be version 0's DATA — not the "1.5.0" CLI version string
        assert.doesNotMatch(stdout.trim(), /^\d+\.\d+\.\d+$/, 'must not print the CLI version string');
        const parsed = JSON.parse(stdout.trim()) as { data: Array<{ content: string }>; version: number };
        assert.equal(parsed.version, 0);
        assert.equal(parsed.data[0].content, 'v0-content');
    });
});
