// =============================================================================
// delete.test — RED spec for `uc delete`. Drives the command against a TEMP
// SQLite db (never ~/.ultracontext) by injecting a resolveClient bound to a
// temp db url, and captures stdout/stderr/exit. Asserts the local-first
// behavior through the ContextClient (Foundation) — no server, no HTTP.
// Behavior: delete messages (--ids) or the whole context (--permanent),
// pipe-aware --json output, and typo-safe arg parsing.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { Command } from '@commander-js/extra-typings';

import { runDelete, buildDeleteCommand } from './delete';
import { createLocalClient } from '../../../lib/clients/local';
import type { ContextClient } from '../../../lib/context-client';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- harness ------------------------------------------------------------------

// a captured run — what the command wrote + the exit code it resolved to
type Capture = { stdout: string; stderr: string; code: number };

// invoke `uc delete <args>` against a single temp db, capturing all io.
// the same dbUrl+cwd back both the seeding client and the command's client,
// so the command observes exactly what we seeded (local-first, one store).
async function runWithDb(
    args: string[],
    db: { dbUrl: string; cwd: string },
    opts: { json?: boolean; isTTY?: boolean } = {},
): Promise<Capture> {
    // accumulate stream writes instead of touching the real process streams
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        // default to a pipe (non-TTY) so output is machine JSON unless overridden
        isTTY: opts.isTTY ?? false,
    };

    // bind the command's client to the SAME temp db the test seeded
    const resolveClient = (): Promise<ContextClient> =>
        createLocalClient({ dbUrl: db.dbUrl, cwd: db.cwd });

    // run the handler with injected deps; it returns the process exit code
    const code = await runDelete(args, { resolveClient, io, json: opts.json });
    return { stdout, stderr, code };
}

// seed a single context (via the Foundation client) and return its id
async function seedContext(db: { dbUrl: string; cwd: string }, messages: Record<string, unknown>[]): Promise<string> {
    const client = await createLocalClient(db);

    // explicit create → append (no default context anymore)
    const ctx = await client.create({});
    await client.append({ id: ctx.id, messages });
    return ctx.id;
}

// -- whole-context delete (--permanent) ---------------------------------------

describe('uc delete --permanent', () => {
    // happy path: deleting the whole context removes it from the store
    it('permanently deletes a context and reports the deleted id', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-permanent' };
        const id = await seedContext(db, [{ role: 'user', content: 'bye' }]);

        const { code } = await runWithDb([id, '--permanent'], db);
        assert.equal(code, 0);

        // the context is gone — reading it back now rejects (not_found)
        const client = await createLocalClient(db);
        await assert.rejects(() => client.get({ id }));
    });

    // --json output shape: a one-line JSON envelope with deleted:true + id
    it('emits a JSON envelope when --json is set', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-json' };
        const id = await seedContext(db, [{ role: 'user', content: 'x' }]);

        const { stdout, stderr, code } = await runWithDb([id, '--permanent'], db, { json: true });
        assert.equal(code, 0);

        // data goes to stdout as exactly one JSON line; stderr stays quiet
        const lines = stdout.trim().split('\n');
        assert.equal(lines.length, 1);
        const parsed = JSON.parse(lines[0]) as { deleted: boolean; id: string };
        assert.equal(parsed.deleted, true);
        assert.equal(parsed.id, id);
        assert.equal(stderr, '');
    });
});

// -- message-level delete (--ids) ---------------------------------------------

describe('uc delete --ids', () => {
    // deleting specific messages by index keeps the context, drops the targets
    it('removes only the targeted messages, leaving the context intact', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-ids' };
        const id = await seedContext(db, [
            { role: 'user', content: 'keep' },
            { role: 'assistant', content: 'drop' },
        ]);

        const { code } = await runWithDb([id, '--ids', '1'], db);
        assert.equal(code, 0);

        // the context still exists with only the survivor message
        const client = await createLocalClient(db);
        const got = await client.get({ id });
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'keep');
    });
});

// -- --meta plumbing (message-level delete) -----------------------------------

describe('uc delete --ids --meta', () => {
    // --meta attaches version metadata to the delete; it surfaces in history
    it('records --meta as version metadata on a message delete', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-meta' };
        const id = await seedContext(db, [
            { role: 'user', content: 'keep' },
            { role: 'assistant', content: 'drop' },
        ]);

        const { code } = await runWithDb([id, '--ids', '1', '--meta', 'reason=cleanup', '--meta', 'by=cli'], db);
        assert.equal(code, 0);

        // the delete version carries the audit metadata we passed via --meta
        const client = await createLocalClient(db);
        const { versions } = await client.get({ id, history: true });
        const del = (versions ?? []).find((v) => v.operation === 'delete');
        assert.ok(del, 'a delete version was recorded');
        assert.equal(del!.metadata?.reason, 'cleanup');
        assert.equal(del!.metadata?.by, 'cli');
    });
});

// -- --meta plumbing (permanent delete) ---------------------------------------

describe('uc delete --permanent --meta', () => {
    // --meta must be OBSERVABLE on the permanent-delete result, not silently
    // dropped: core echoes audit metadata back, and the client must surface it.
    it('echoes --meta as audit metadata on the permanent-delete envelope', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-perm-meta' };
        const id = await seedContext(db, [{ role: 'user', content: 'bye' }]);

        const { stdout, code } = await runWithDb(
            [id, '--permanent', '--meta', 'reason=gdpr', '--meta', 'by=cli'],
            db,
            { json: true },
        );
        assert.equal(code, 0);

        // the envelope confirms the deleted id AND surfaces the audit metadata
        const parsed = JSON.parse(stdout.trim()) as {
            deleted: boolean;
            id: string;
            metadata?: Record<string, unknown>;
        };
        assert.equal(parsed.deleted, true);
        assert.equal(parsed.id, id);
        assert.ok(parsed.metadata, 'audit metadata is surfaced on the result');
        assert.equal(parsed.metadata!.reason, 'gdpr');
        assert.equal(parsed.metadata!.by, 'cli');
    });
});

// -- bare delete is an error (no --permanent, no --ids) -----------------------

describe('uc delete (bare, no flags) is an error', () => {
    // A bare `delete <id>` must NOT wipe the whole context — that is far too
    // destructive to be the default. It errors (exit 1) and leaves the context.
    it('errors and deletes nothing without --permanent or --ids (handler)', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-bare' };
        const id = await seedContext(db, [{ role: 'user', content: 'precious' }]);

        const { code, stderr } = await runWithDb([id], db);
        assert.equal(code, 1);
        assert.match(stderr, /--permanent|--ids/);

        // the context is STILL there — nothing was deleted
        const client = await createLocalClient(db);
        const got = await client.get({ id });
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'precious');
    });

    // same guarantee through the REAL registered action (argv path)
    it('errors and deletes nothing via the registered action (argv)', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-bare-argv' };
        const id = await seedContext(db, [{ role: 'user', content: 'keepme' }]);

        const savedDb = process.env.UC_DB_URL;
        const savedCode = process.exitCode;
        process.env.UC_DB_URL = db.dbUrl;
        process.exitCode = 0;

        try {
            const program = new Command('uc');
            program.option('--json');
            program.addCommand(buildDeleteCommand());
            program.exitOverride();
            // `uc delete <id>` with NO flags — the wipe footgun
            await program.parseAsync(['node', 'uc', 'delete', id]);

            // the registered action must have flagged a non-zero exit
            assert.notEqual(process.exitCode, 0);
        } finally {
            process.exitCode = savedCode;
            if (savedDb === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = savedDb;
        }

        // the context is untouched — a bare delete never wipes
        const client = await createLocalClient(db);
        const got = await client.get({ id });
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'keepme');
    });
});

// -- error case ---------------------------------------------------------------

describe('uc delete errors', () => {
    // deleting a non-existent id fails cleanly: non-zero exit + error on stderr
    it('exits non-zero with an error envelope for a missing context', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-missing' };

        const { stdout, stderr, code } = await runWithDb(['ctx_does_not_exist', '--permanent'], db, { json: true });
        assert.equal(code, 1);

        // no data line on stdout; the failure surfaces as a JSON error on stderr
        assert.equal(stdout, '');
        const parsed = JSON.parse(stderr.trim()) as { error: string };
        assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
    });
});

// -- registered command wiring (real action path) ----------------------------

describe('uc delete --ids (registered command)', () => {
    // Drive the REAL buildDeleteCommand action through a program, the way argv
    // hits it. Commander consumes --ids into the action's parsed opts, so the
    // action must NOT lose it: a message delete must keep the context intact and
    // never silently fall through to a permanent (whole-context) delete.
    it('soft-deletes a message via the registered action, leaving the context', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-registered' };
        const id = await seedContext(db, [
            { role: 'user', content: 'keep' },
            { role: 'assistant', content: 'drop' },
        ]);

        // point the registered action's resolveClient at the SAME temp db via env
        const savedDb = process.env.UC_DB_URL;
        process.env.UC_DB_URL = db.dbUrl;

        try {
            // a root program carrying the global --json + the real delete command
            const program = new Command('uc');
            program.option('--json');
            program.addCommand(buildDeleteCommand());
            program.exitOverride();

            // argv: `uc --json delete <id> --ids 1` — the path that was broken
            await program.parseAsync(['node', 'uc', '--json', 'delete', id, '--ids', '1']);
        } finally {
            if (savedDb === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = savedDb;
        }

        // the context still exists with only the survivor — NOT wiped
        const client = await createLocalClient(db);
        const got = await client.get({ id });
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'keep');
    });
});

// -- batch delete (multiple ids) ----------------------------------------------

describe('uc delete <id...> (batch)', () => {
    // happy path: multiple ids + --permanent → all deleted, exit 0, JSON envelope
    it('permanently deletes many contexts and emits the {results, deleted_count} envelope', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-ok' };
        const a = await seedContext(db, [{ content: 'a' }]);
        const b = await seedContext(db, [{ content: 'b' }]);

        const { stdout, stderr, code } = await runWithDb([a, b, '--permanent'], db, { json: true });
        assert.equal(code, 0, 'all deleted → exit 0');

        // the envelope reports both rows + a deleted_count of 2
        const parsed = JSON.parse(stdout.trim()) as { results: Array<{ id: string; deleted: boolean }>; deleted_count: number };
        assert.equal(parsed.deleted_count, 2);
        assert.equal(parsed.results.length, 2);
        assert.ok(parsed.results.every((r) => r.deleted));
        assert.equal(stderr, '');

        // both contexts are actually gone
        const client = await createLocalClient(db);
        await assert.rejects(() => client.get({ id: a }));
        await assert.rejects(() => client.get({ id: b }));
    });

    // multiple ids WITHOUT --permanent must error (batch is always permanent)
    it('refuses a multi-id delete without --permanent and deletes nothing', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-noperm' };
        const a = await seedContext(db, [{ content: 'a' }]);
        const b = await seedContext(db, [{ content: 'b' }]);

        const { code, stderr } = await runWithDb([a, b], db, { json: true });
        assert.equal(code, 1);
        assert.match(stderr, /permanent/);

        // both contexts are untouched — the guard aborted before any delete
        const client = await createLocalClient(db);
        assert.equal((await client.get({ id: a })).data.length, 1);
        assert.equal((await client.get({ id: b })).data.length, 1);
    });

    // multiple ids combined with --ids is ambiguous (whole-context vs message) → error
    it('refuses combining multiple ids with --ids as ambiguous', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-ids' };
        const a = await seedContext(db, [{ content: 'a' }]);
        const b = await seedContext(db, [{ content: 'b' }]);

        const { code, stderr } = await runWithDb([a, b, '--permanent', '--ids', '0'], db, { json: true });
        assert.equal(code, 1);
        assert.match(stderr, /ids|message/);

        // nothing was deleted — the ambiguity aborted up front
        const client = await createLocalClient(db);
        assert.equal((await client.get({ id: a })).data.length, 1);
        assert.equal((await client.get({ id: b })).data.length, 1);
    });

    // partial failure: one real id + one missing id → exit 1, rows still surfaced
    it('exits 1 on a partial failure but still surfaces every row', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-partial' };
        const a = await seedContext(db, [{ content: 'a' }]);

        const { stdout, code } = await runWithDb([a, 'ctx_missing', '--permanent'], db, { json: true });
        assert.equal(code, 1, 'any failed row → exit 1');

        // the envelope is STILL on stdout, with per-id rows + the error reason
        const parsed = JSON.parse(stdout.trim()) as { results: Array<{ id: string; deleted: boolean; error?: string }>; deleted_count: number };
        assert.equal(parsed.deleted_count, 1);
        const bad = parsed.results.find((r) => r.id === 'ctx_missing');
        assert.equal(bad?.deleted, false);
        assert.ok(bad?.error);

        // the real context was deleted despite the sibling failure (no abort)
        const client = await createLocalClient(db);
        await assert.rejects(() => client.get({ id: a }));
    });

    // human (non-JSON) output: one line per id + a count summary on a TTY
    it('prints one line per id plus a count summary in human mode', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-human' };
        const a = await seedContext(db, [{ content: 'a' }]);
        const b = await seedContext(db, [{ content: 'b' }]);

        const { stdout, code } = await runWithDb([a, b, '--permanent'], db, { isTTY: true });
        assert.equal(code, 0);

        // every id appears on its own line, plus a summary mentioning the count
        assert.match(stdout, new RegExp(a));
        assert.match(stdout, new RegExp(b));
        assert.match(stdout, /2/);
    });
});

// -- $UC_CONTEXT fallback (single-target only) --------------------------------

describe('uc delete $UC_CONTEXT fallback', () => {
    // with ZERO positionals, the env var supplies the single target (unchanged)
    it('uses $UC_CONTEXT when no id positional is given', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-envctx' };
        const id = await seedContext(db, [{ content: 'bye' }]);

        const savedCtx = process.env.UC_CONTEXT;
        process.env.UC_CONTEXT = id;
        try {
            const { code } = await runWithDb(['--permanent'], db);
            assert.equal(code, 0);
        } finally {
            if (savedCtx === undefined) delete process.env.UC_CONTEXT;
            else process.env.UC_CONTEXT = savedCtx;
        }

        // the env-targeted context is gone
        const client = await createLocalClient(db);
        await assert.rejects(() => client.get({ id }));
    });
});

// -- batch via the registered action (argv path) ------------------------------

describe('uc delete <id...> (registered command, argv)', () => {
    // drive the REAL action through parseAsync: multi-id + --permanent batch
    it('batch-deletes via the registered action, exit 0 when all deleted', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-batch-argv' };
        const a = await seedContext(db, [{ content: 'a' }]);
        const b = await seedContext(db, [{ content: 'b' }]);

        const savedDb = process.env.UC_DB_URL;
        const savedCode = process.exitCode;
        process.env.UC_DB_URL = db.dbUrl;
        process.exitCode = 0;

        try {
            const program = new Command('uc');
            program.option('--json');
            program.addCommand(buildDeleteCommand());
            program.exitOverride();
            await program.parseAsync(['node', 'uc', '--json', 'delete', a, b, '--permanent']);
            assert.equal(process.exitCode, 0);
        } finally {
            process.exitCode = savedCode;
            if (savedDb === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = savedDb;
        }

        // both contexts gone
        const client = await createLocalClient(db);
        await assert.rejects(() => client.get({ id: a }));
        await assert.rejects(() => client.get({ id: b }));
    });
});

// -- typo-safe parsing --------------------------------------------------------

describe('uc delete is typo-safe', () => {
    // an unknown flag is rejected (non-zero) rather than silently ignored
    it('rejects unknown options instead of running the delete', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-typo' };
        const id = await seedContext(db, [{ role: 'user', content: 'safe' }]);

        const { code } = await runWithDb([id, '--permnent'], db);
        assert.notEqual(code, 0);

        // the context is untouched — the typo aborted before any delete
        const client = await createLocalClient(db);
        const got = await client.get({ id });
        assert.equal(got.data.length, 1);
    });
});
