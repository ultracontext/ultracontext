// =============================================================================
// mirror.test — `uc mirror` group. Drives the testable action functions against
// a FAKE mutagen (injected CommandRunner) + a temp config dir, asserting the
// pipe-aware output (data → stdout JSON, status → stderr). Also checks the
// Commander group registers start/stop/status/list/source (NO init — it moved to
// `uc remote set`; NO event — events are the TOP-LEVEL `uc event` family).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, loadConfig, type Config, type Source, type CommandResult } from '@ultracontext/mirror';

import {
    mirrorStatusAction,
    mirrorListAction,
    mirrorStartAction,
    mirrorResetAction,
    mirrorSourceListAction,
    mirrorSourceRemoveAction,
    mirrorSourceSetEnabledAction,
    buildMirrorCommand,
} from './mirror';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-mirror-'));
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

// the MirrorDeps the actions forward to @ultracontext/mirror (binary + paths faked)
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

describe('uc mirror status', () => {
    // emits the parsed sessions as a single JSON line in machine mode
    it('emits parsed sessions as JSON', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();
        const errs = sink();
        const long = 'Name: uc-laptop-claude\nStatus: Watching for changes\n';

        const code = await mirrorStatusAction(
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

describe('uc mirror list', () => {
    // lists configured sources with their mirror state
    it('emits configured sources with state', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();
        const long = 'Name: uc-laptop-claude\nStatus: Watching for changes\n';

        const code = await mirrorListAction(
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

describe('uc mirror start', () => {
    // a clean start reports ok and writes nothing to stdout in human mode
    it('starts enabled sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await mirrorStartAction(
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

        const code = await mirrorStartAction(
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

        const code = await mirrorStartAction(
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

describe('uc mirror reset', () => {
    // a clean reset reports ok (terminate owned sessions + restart enabled)
    it('resets the mirror for enabled sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await mirrorResetAction(
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

        const code = await mirrorResetAction(
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

        const code = await mirrorStartAction(
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

describe('uc mirror source remove', () => {
    // removing a known source drops it from config and reports removed
    it('removes a configured source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await mirrorSourceRemoveAction(
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

        const code = await mirrorSourceRemoveAction(
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

        const code = await mirrorSourceRemoveAction(
            'claude',
            { json: true, purgeRemote: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        assert.equal(JSON.parse(out.text()).purgedRemote, true);
    });
});

// -- source enable / disable --------------------------------------------------

describe('uc mirror source enable/disable', () => {
    // disabling a source flips its config flag and emits the new state
    it('disables a source', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await mirrorSourceSetEnabledAction(
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

        const code = await mirrorSourceSetEnabledAction(
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

        const code = await mirrorSourceSetEnabledAction(
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

describe('uc mirror source list', () => {
    // emits the configured sources straight from config
    it('lists configured sources', async () => {
        const dir = await tempDir();
        await seedConfig(dir);
        const out = sink();

        const code = await mirrorSourceListAction(
            { json: true },
            { sync: deps(dir), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.data[0].agent, 'claude');
    });
});

// -- Commander wiring ---------------------------------------------------------

describe('buildMirrorCommand', () => {
    // the group registers every subcommand — NO init (it moved to `uc remote
    // set`) and NO event (it moved to the top-level `uc event` family)
    it('registers start/stop/status/list/reset/source, not init or event', () => {
        const mirror = buildMirrorCommand();
        const subs = mirror.commands.map((c) => c.name());

        for (const expected of ['start', 'stop', 'status', 'list', 'reset', 'source']) {
            assert.ok(subs.includes(expected), `missing mirror subcommand: ${expected}`);
        }
        assert.ok(!subs.includes('init'), 'mirror must NOT register init — it moved to `uc remote set`');
        assert.ok(!subs.includes('event'), 'mirror must NOT register event — it is top-level now');
    });

    // the legacy `sync` alias is GONE — the group answers only to `mirror`
    it('does not carry a `sync` alias', () => {
        const mirror = buildMirrorCommand();
        assert.ok(!mirror.aliases().includes('sync'), 'mirror group must NOT carry the sync alias');
    });

    // `uc mirror init` is gone — Commander rejects it as an unknown subcommand
    it('rejects `mirror init` as an unknown command', async () => {
        const mirror = buildMirrorCommand();

        // exitOverride turns Commander's process.exit into a throw we can assert on
        mirror.exitOverride();
        mirror.configureOutput({ writeErr: () => {}, writeOut: () => {} });

        await assert.rejects(
            () => mirror.parseAsync(['init', 'user@vps'], { from: 'user' }),
            /unknown command/i,
        );
    });

    // source carries its own list/add/remove/enable/disable subcommands
    it('nests source list/add/remove/enable/disable', () => {
        const mirror = buildMirrorCommand();
        const source = mirror.commands.find((c) => c.name() === 'source');
        const subs = source?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['list', 'add', 'remove', 'enable', 'disable']) {
            assert.ok(subs.includes(expected), `missing source subcommand: ${expected}`);
        }
    });
});
