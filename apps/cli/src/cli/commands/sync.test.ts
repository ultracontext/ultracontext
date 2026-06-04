// =============================================================================
// sync.test — `uc sync` group. Drives the testable action functions against a
// FAKE mutagen (injected CommandRunner) + a temp config dir, asserting the
// pipe-aware output (data → stdout JSON, status → stderr). Also checks the
// Commander group registers start/stop/status/list/source (NO init — it moved
// to `uc remote set`; NO event — events are the TOP-LEVEL `uc event` family).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, loadConfig, type Config, type Source, type CommandResult } from '@ultracontext/sync';

import {
    syncStatusAction,
    syncListAction,
    syncStartAction,
    syncResetAction,
    syncSourceListAction,
    syncSourceRemoveAction,
    syncSourceSetEnabledAction,
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

// read the configured sources back from a temp config dir
async function sourceListFor(dir: string): Promise<Source[]> {
    return (await loadConfig(dir)).sources;
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

    // PIPE-AWARENESS on the ERROR path: a piped (non-TTY) stdout WITHOUT --json
    // must still emit a machine-JSON error envelope, matching the data path
    it('emits a JSON error when stdout is piped, even without --json', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncStartAction(
            {},
            {
                sync: { ...deps(dir), commandExists: async () => false },
                io: { stdout: sink(), stderr: errs, isTTY: false },
            },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /mutagen/);
    });
});

// -- reset --------------------------------------------------------------------

describe('uc sync reset', () => {
    // a clean reset reports ok (terminate owned sessions + restart enabled)
    it('resets sync for enabled sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncResetAction(
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        assert.equal(JSON.parse(out.text()).ok, true);
    });

    // a missing mutagen binary surfaces as exit 1 with an error on stderr
    it('exits 1 when mutagen is missing', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncResetAction(
            { json: true },
            {
                sync: { ...deps(dir), commandExists: async () => false },
                io: { stdout: sink(), stderr: errs, isTTY: true },
            },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /mutagen/);
    });

    // PIPE-AWARENESS on the ERROR path: a piped (non-TTY) stdout WITHOUT --json
    // must still emit a machine-JSON error envelope, matching the data path
    it('emits a JSON error when stdout is piped, even without --json', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncStartAction(
            {},
            {
                sync: { ...deps(dir), commandExists: async () => false },
                io: { stdout: sink(), stderr: errs, isTTY: false },
            },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /mutagen/);
    });
});

// -- source remove ------------------------------------------------------------

describe('uc sync source remove', () => {
    // removing a known source drops it from config and reports removed
    it('removes a configured source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncSourceRemoveAction(
            'claude',
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.removed, true);
        assert.equal(payload.name, 'claude');
        assert.equal(payload.purgedRemote, false);

        // the source is gone from config
        const sources = await sourceListFor(dir);
        assert.equal(sources.length, 0);
    });

    // an unknown source name is a clean exit-1 error
    it('exits 1 for an unknown source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncSourceRemoveAction(
            'nope',
            { json: true },
            { sync: deps(dir), io: { stdout: sink(), stderr: errs, isTTY: true } },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /not found/);
    });

    // --purge-remote threads through to a destructive remote-dir deletion
    it('reports purgedRemote when the flag is set', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncSourceRemoveAction(
            'claude',
            { json: true, purgeRemote: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        assert.equal(JSON.parse(out.text()).purgedRemote, true);
    });
});

// -- source enable / disable --------------------------------------------------

describe('uc sync source enable/disable', () => {
    // disabling a source flips its config flag and emits the new state
    it('disables a source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await syncSourceSetEnabledAction(
            'claude',
            false,
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.name, 'claude');
        assert.equal(payload.enabled, false);

        // the config reflects the disabled state
        const sources = await sourceListFor(dir);
        assert.equal(sources[0].enabled, false);
    });

    // enabling re-flips the flag and emits enabled:true
    it('enables a source', async () => {
        const dir = await tempDir();
        const config = await seedConfig(dir);
        config.sources[0].enabled = false;
        await saveConfig(config, dir);
        const out = sink();

        const code = await syncSourceSetEnabledAction(
            'claude',
            true,
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        assert.equal(JSON.parse(out.text()).enabled, true);
    });

    // an unknown source name is a clean exit-1 error
    it('exits 1 for an unknown source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const errs = sink();

        const code = await syncSourceSetEnabledAction(
            'nope',
            true,
            { json: true },
            { sync: deps(dir), io: { stdout: sink(), stderr: errs, isTTY: true } },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /not found/);
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
    // the group registers every subcommand — NO init (it moved to `uc remote
    // set`) and NO event (it moved to the top-level `uc event` family)
    it('registers start/stop/status/list/reset/source, not init or event', () => {
        const sync = buildSyncCommand();
        const subs = sync.commands.map((c) => c.name());

        for (const expected of ['start', 'stop', 'status', 'list', 'reset', 'source']) {
            assert.ok(subs.includes(expected), `missing sync subcommand: ${expected}`);
        }
        assert.ok(!subs.includes('init'), 'sync must NOT register init — it moved to `uc remote set`');
        assert.ok(!subs.includes('event'), 'sync must NOT register event — it is top-level now');
    });

    // `uc sync init` is gone — Commander rejects it as an unknown subcommand
    it('rejects `sync init` as an unknown command', async () => {
        const sync = buildSyncCommand();

        // exitOverride turns Commander's process.exit into a throw we can assert on
        sync.exitOverride();
        sync.configureOutput({ writeErr: () => {}, writeOut: () => {} });

        await assert.rejects(
            () => sync.parseAsync(['init', 'user@vps'], { from: 'user' }),
            /unknown command/i,
        );
    });

    // source carries its own list/add/remove/enable/disable subcommands
    it('nests source list/add/remove/enable/disable', () => {
        const sync = buildSyncCommand();
        const source = sync.commands.find((c) => c.name() === 'source');
        const subs = source?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['list', 'add', 'remove', 'enable', 'disable']) {
            assert.ok(subs.includes(expected), `missing source subcommand: ${expected}`);
        }
    });
});
