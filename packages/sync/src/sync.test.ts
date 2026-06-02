// =============================================================================
// sync.test — start/stop/status/reset/list orchestration against a FAKE
// mutagen (an injected CommandRunner that records invocations + returns canned
// stdout). No real binary, no network. Each test gets a temp config + a fake.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, type Config } from './config';
import {
    syncStart,
    syncStop,
    syncStatus,
    syncReset,
    syncList,
    type SyncDeps,
} from './sync';
import type { CommandResult } from './mutagen';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-sync-orc-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- fake mutagen + deps ------------------------------------------------------

// records every command and replies from a name→stdout map (default: empty list)
function fakeRunner(responses: Record<string, string> = {}) {
    const calls: string[][] = [];

    const run = async (program: string, args: string[]): Promise<CommandResult> => {
        calls.push([program, ...args]);

        // a `sync list` reply is keyed by 'list' (long or short share the key)
        if (program === 'mutagen' && args[0] === 'sync' && args[1] === 'list') {
            return { code: 0, stdout: responses.list ?? '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    };

    return { run, calls };
}

// build SyncDeps around a fake runner; lets local-workspace paths exist under dir
function deps(configDir: string, runner: ReturnType<typeof fakeRunner>): SyncDeps {
    return {
        configDir,
        runCommand: runner.run,
        // pretend the mutagen binary + every local source path are present
        commandExists: async () => true,
        pathExists: async () => true,
    };
}

// a config whose sources all live locally — `local` skips ssh prep
async function seedLocalConfig(dir: string): Promise<Config> {
    const config: Config = {
        remote: 'local',
        remoteRoot: join(dir, 'remote'),
        hostId: 'laptop',
        sources: [
            { agent: 'claude', localPath: join(dir, 'claude'), enabled: true },
            { agent: 'codex', localPath: join(dir, 'codex'), enabled: false },
        ],
    };
    await saveConfig(config, dir);
    return config;
}

// pull the mutagen subcommand chain out of a recorded call list
function mutagenCalls(calls: string[][]): string[][] {
    return calls.filter((c) => c[0] === 'mutagen').map((c) => c.slice(1));
}

// -- start --------------------------------------------------------------------

describe('syncStart', () => {
    // creates a session for each ENABLED source (codex is disabled → skipped)
    it('creates a session per enabled source', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        // exactly one `sync create` (for claude), none for the disabled codex
        const creates = mutagenCalls(runner.calls).filter((c) => c[0] === 'sync' && c[1] === 'create');
        assert.equal(creates.length, 1);
        assert.ok(creates[0].some((a) => a.includes('--name=uc-laptop-claude')));
    });

    // an already-present session is resumed + flushed instead of recreated
    it('resumes an existing session', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Paused\n' });

        await syncStart(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'resume' && c[2] === 'uc-laptop-claude'));
        assert.ok(cmds.some((c) => c[1] === 'flush' && c[2] === 'uc-laptop-claude'));
        assert.ok(!cmds.some((c) => c[1] === 'create'));
    });

    // a missing mutagen binary is a clean error before anything is attempted
    it('errors when mutagen is not installed', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();
        const d: SyncDeps = { ...deps(dir, runner), commandExists: async () => false };

        await assert.rejects(syncStart(d), /mutagen/);
    });
});

// -- stop ---------------------------------------------------------------------

describe('syncStop', () => {
    // pauses every enabled session that currently exists
    it('pauses enabled sessions that exist', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await syncStop(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'pause' && c[2] === 'uc-laptop-claude'));
    });
});

// -- status -------------------------------------------------------------------

describe('syncStatus', () => {
    // returns the parsed SessionInfo[] from `sync list --long`
    it('returns parsed sessions', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const long = `Name: uc-laptop-claude
Alpha:
        URL: /a
        Connected: Yes
Beta:
        URL: /b
        Connected: Yes
Status: Watching for changes
`;
        const runner = fakeRunner({ list: long });

        const sessions = await syncStatus(deps(dir, runner));

        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].name, 'uc-laptop-claude');
        assert.equal(sessions[0].status, 'Watching for changes');
        // it asked for the long form
        assert.ok(mutagenCalls(runner.calls).some((c) => c.includes('--long')));
    });
});

// -- list ---------------------------------------------------------------------

describe('syncList', () => {
    // one entry per configured source, carrying its sync state + endpoint
    it('lists configured sources with state', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        const entries = await syncList(deps(dir, runner));

        const claude = entries.find((e) => e.source === 'claude');
        assert.ok(claude);
        assert.equal(claude.sourceState, 'enabled');
        assert.equal(claude.syncState, 'Watching for changes');

        // codex is configured but disabled and has no session → missing
        const codex = entries.find((e) => e.source === 'codex');
        assert.equal(codex?.sourceState, 'disabled');
        assert.equal(codex?.syncState, 'missing');
    });
});

// -- reset --------------------------------------------------------------------

describe('syncReset', () => {
    // terminates owned sessions, then re-starts enabled ones
    it('terminates owned sessions then restarts', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await syncReset(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'terminate' && c[2] === 'uc-laptop-claude'));
    });
});
