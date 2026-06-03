// =============================================================================
// sync.test — `uc sync` group. Drives the testable action functions against a
// FAKE mutagen (injected CommandRunner) + a temp config dir, asserting the
// pipe-aware output (data → stdout JSON, status → stderr). Also checks the
// Commander group registers init/start/stop/status/list/source (NO event —
// events are the TOP-LEVEL `uc event` family now).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, type Config, type CommandResult } from '@ultracontext/sync';

import {
    syncStatusAction,
    syncListAction,
    syncStartAction,
    syncSourceListAction,
    buildSyncCommand,
} from './sync';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-sync-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- capture + fake helpers ---------------------------------------------------

// a writable-like sink recording everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// a fake mutagen runner replying canned `sync list` stdout
function fakeRunner(listOut = '') {
    return async (program: string, args: string[]): Promise<CommandResult> => {
        if (program === 'mutagen' && args[0] === 'sync' && args[1] === 'list') {
            return { code: 0, stdout: listOut, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    };
}

// the SyncDeps the actions forward to @ultracontext/sync (binary + paths faked)
function deps(configDir: string, listOut = '') {
    return {
        configDir,
        runCommand: fakeRunner(listOut),
        commandExists: async () => true,
        pathExists: async () => true,
    };
}

// seed a local config with one enabled source
async function seedConfig(dir: string): Promise<Config> {
    const config: Config = {
        remote: 'local',
        remoteRoot: join(dir, 'remote'),
        hostId: 'laptop',
        sources: [{ agent: 'claude', localPath: join(dir, 'claude'), enabled: true }],
    };
    await saveConfig(config, dir);
    return config;
}

// -- status -------------------------------------------------------------------

describe('uc sync status', () => {
    // emits the parsed sessions as a single JSON line in machine mode
    it('emits parsed sessions as JSON', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();
        const errs = sink();
        const long = 'Name: uc-laptop-claude\nStatus: Watching for changes\n';

        const code = await syncStatusAction(
            { json: true },
            { sync: deps(dir, long), io: { stdout: out, stderr: errs, isTTY: true } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.data[0].name, 'uc-laptop-claude');
        assert.equal(errs.text(), '');
    });
});

// -- list ---------------------------------------------------------------------

describe('uc sync list', () => {
    // lists configured sources with their sync state
    it('emits configured sources with state', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();
        const long = 'Name: uc-laptop-claude\nStatus: Watching for changes\n';

        const code = await syncListAction(
            { json: true },
            { sync: deps(dir, long), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.data[0].source, 'claude');
        assert.equal(payload.data[0].syncState, 'Watching for changes');
    });
});

// -- start --------------------------------------------------------------------

describe('uc sync start', () => {
    // a clean start reports ok and writes nothing to stdout in human mode
    it('starts enabled sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncStartAction(
            {},
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: true } },
        );

        assert.equal(code, 0);
    });

    // a missing mutagen binary surfaces as exit 1 with an error on stderr
    it('exits 1 when mutagen is missing', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncStartAction(
            { json: true },
            {
                sync: { ...deps(dir), commandExists: async () => false },
                io: { stdout: sink(), stderr: errs, isTTY: true },
            },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /mutagen/);
    });
});

// -- source list --------------------------------------------------------------

describe('uc sync source list', () => {
    // emits the configured sources straight from config
    it('lists configured sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncSourceListAction(
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.data[0].agent, 'claude');
    });
});

// -- Commander wiring ---------------------------------------------------------

describe('buildSyncCommand', () => {
    // the group registers every subcommand — and NO event (it moved top-level)
    it('registers init/start/stop/status/list/source, not event', () => {
        const sync = buildSyncCommand();
        const subs = sync.commands.map((c) => c.name());

        for (const expected of ['init', 'start', 'stop', 'status', 'list', 'source']) {
            assert.ok(subs.includes(expected), `missing sync subcommand: ${expected}`);
        }
        assert.ok(!subs.includes('event'), 'sync must NOT register event — it is top-level now');
    });

    // source carries its own list/add subcommands
    it('nests source list/add', () => {
        const sync = buildSyncCommand();
        const source = sync.commands.find((c) => c.name() === 'source');
        const subs = source?.commands.map((c) => c.name()) ?? [];

        assert.ok(subs.includes('list'));
        assert.ok(subs.includes('add'));
    });
});
