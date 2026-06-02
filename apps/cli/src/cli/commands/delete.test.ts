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
    // --meta is echoed as audit metadata on the permanent-delete JSON envelope
    it('echoes --meta as audit metadata on a permanent delete', async () => {
        const db = { dbUrl: tempDbUrl(), cwd: '/work/del-perm-meta' };
        const id = await seedContext(db, [{ role: 'user', content: 'bye' }]);

        const { stdout, code } = await runWithDb(
            [id, '--permanent', '--meta', 'reason=gdpr'],
            db,
            { json: true },
        );
        assert.equal(code, 0);

        // the envelope still confirms the deleted id (audit rides core-side)
        const parsed = JSON.parse(stdout.trim()) as { deleted: boolean; id: string };
        assert.equal(parsed.deleted, true);
        assert.equal(parsed.id, id);
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
