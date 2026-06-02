// =============================================================================
// roundtrip.test — integration. ALL context verbs must honor the SAME env-aware
// local store. We set UC_DB_URL + UC_PROJECT_DIR in env (NOT via injected ctx),
// drive the real command actions (create → append → get → list), and assert the
// message round-trips through the one env-specified db. Guards the centralized-
// config fix: before it, get/list ignored the env and read a different db.
// =============================================================================

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { runCreate } from './create';
import { buildAppendCommand } from './append';
import { buildGetCommand } from './get';
import { registerList } from './list';
import { Command } from '@commander-js/extra-typings';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

after(cleanupTempDbs);

// -- env-driven scope ---------------------------------------------------------

// the per-test temp db + cwd, wired through env so EVERY verb resolves them
let dbUrl: string;
let cwd: string;
let saved: { db?: string; dir?: string };

// point the whole CLI at a throwaway db + unique cwd via env only
beforeEach(() => {
    dbUrl = tempDbUrl();
    cwd = '/work/roundtrip-' + Math.random().toString(36).slice(2);
    saved = { db: process.env.UC_DB_URL, dir: process.env.UC_PROJECT_DIR };
    process.env.UC_DB_URL = dbUrl;
    process.env.UC_PROJECT_DIR = cwd;
});

// restore env so tests don't leak into each other
afterEach(() => {
    if (saved.db === undefined) delete process.env.UC_DB_URL;
    else process.env.UC_DB_URL = saved.db;
    if (saved.dir === undefined) delete process.env.UC_PROJECT_DIR;
    else process.env.UC_PROJECT_DIR = saved.dir;
});

// -- io capture ---------------------------------------------------------------

// a buffer-backed io sink forced into machine mode (deterministic JSON)
function makeIo() {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        isTTY: false,
    };
    return { io, out: () => stdout, err: () => stderr };
}

// -- command drivers ----------------------------------------------------------

// drive `uc create` with injected io (resolving the store via env), returning
// the new context id off the JSON envelope. No global stdout patch needed: the
// create handler takes an injectable io directly.
async function driveCreate(): Promise<string> {
    const captured = makeIo();
    await runCreate({ json: true }, { io: captured.io });
    return JSON.parse(captured.out().trim()).id;
}

// drive `uc append <id> --json`, appending one message to the explicit context
async function driveAppend(id: string, text: string): Promise<void> {
    const captured = makeIo();
    const command = buildAppendCommand({ io: captured.io, exit: () => {} });
    await command.parseAsync(['node', 'append', id, text, '--json']);
}

// drive `uc get <id>` through the real program so it resolves via env (no ctx)
async function driveGet(id: string): Promise<string> {
    // wrap the verb in a root carrying the global --json so machine output is on
    const program = new Command('uc');
    program.option('--json');
    program.addCommand(buildGetCommand());
    program.exitOverride();

    // the get action reads io from the live process — capture via a patched stdout
    const captured = makeIo();
    const restore = patchStdout(captured.io.stdout.write);
    try {
        await program.parseAsync(['node', 'uc', '--json', 'get', id]);
    } finally {
        restore();
    }
    return captured.out();
}

// drive `uc list` through the real program (resolves via env, no ctx)
async function driveList(): Promise<string> {
    const program = new Command('uc');
    program.option('--json');
    registerList(program);

    const captured = makeIo();
    const restore = patchStdout(captured.io.stdout.write);
    try {
        await program.parseAsync(['node', 'uc', '--json', 'list']);
    } finally {
        restore();
    }
    return captured.out();
}

// -- stdout patch -------------------------------------------------------------

// temporarily redirect process.stdout.write to a sink (get/list write live io)
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

// -- the round-trip -----------------------------------------------------------

describe('env-aware round-trip across verbs', () => {
    // create+append write through env; get reads the SAME env-specified db by id
    it('create → append → get round-trips through the env-specified db', async () => {
        const id = await driveCreate();
        await driveAppend(id, 'cross-verb note');

        // get must hit the same UC_DB_URL/UC_PROJECT_DIR create+append used
        const getOut = await driveGet(id);
        const parsed = JSON.parse(getOut.trim());
        assert.equal(parsed.data.length, 1);
        assert.equal(parsed.data[0].content, 'cross-verb note');
    });

    // list sees the context create minted in the env-specified db
    it('create → list surfaces the context from the env-specified db', async () => {
        const id = await driveCreate();
        await driveAppend(id, 'listed note');

        const listOut = await driveList();
        const parsed = JSON.parse(listOut.trim());
        assert.ok(Array.isArray(parsed.data), 'list returns a data array');
        assert.ok(parsed.data.length >= 1, 'the created context is listed');
    });
});
