// =============================================================================
// transport.test — hub resolution + the SSH Deliver. Drives a temp sync config
// dir and an INJECTED CommandRunner (no real SSH). Asserts: local config →
// localMode + target 'local'; remote config → target = the ssh host + a Deliver
// that pipes the envelope JSON to `ssh <host> 'uc event commit --from-stdin'`,
// resolving true on exit 0 and false (stays pending) on nonzero.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, type Config, type CommandResult } from '@ultracontext/sync';

import { resolveTransport } from './transport';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-evt-transport-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- fakes --------------------------------------------------------------------

// records every command invocation + its piped stdin, replying a canned code
function recordingRunner(code: number) {
    const calls: { program: string; args: string[]; stdin?: string }[] = [];
    const run = async (program: string, args: string[], stdin?: string): Promise<CommandResult> => {
        calls.push({ program, args, stdin });
        return { code, stdout: '', stderr: code === 0 ? '' : 'uc: command not found' };
    };
    return { run, calls };
}

// seed a local-target sync config
async function seedLocal(dir: string): Promise<void> {
    const config: Config = { remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] };
    await saveConfig(config, dir);
}

// seed a remote-target (ssh) sync config
async function seedRemote(dir: string): Promise<void> {
    const config: Config = { remote: 'fabio@mini', remoteRoot: '~/.ultracontext', hostId: 'laptop', sources: [] };
    await saveConfig(config, dir);
}

// -- local mode ---------------------------------------------------------------

describe('resolveTransport (local config)', () => {
    // a 'local' remote → localMode true, target 'local', host = config.hostId
    it('reports localMode with target local', async () => {
        const dir = await tempDir();
        await seedLocal(dir);

        const t = await resolveTransport({ configDir: dir });

        assert.equal(t.localMode, true);
        assert.equal(t.target, 'local');
        assert.equal(t.host, 'laptop');
    });
});

// -- no config (default local) ------------------------------------------------

describe('resolveTransport (no config)', () => {
    // a missing config falls back to local mode with a derived host id
    it('defaults to local mode when no config exists', async () => {
        const dir = await tempDir();

        const t = await resolveTransport({ configDir: dir });

        assert.equal(t.localMode, true);
        assert.equal(t.target, 'local');
        assert.ok(t.host.length > 0);
    });
});

// -- remote mode --------------------------------------------------------------

describe('resolveTransport (remote config)', () => {
    // a ssh remote → localMode false, target = the ssh host, host = config.hostId
    it('reports remote mode with the ssh target', async () => {
        const dir = await tempDir();
        await seedRemote(dir);

        const t = await resolveTransport({ configDir: dir, runner: recordingRunner(0).run });

        assert.equal(t.localMode, false);
        assert.equal(t.target, 'fabio@mini');
        assert.equal(t.host, 'laptop');
    });

    // deliver pipes the envelope JSON to `ssh <host> 'uc event commit --from-stdin'`
    it('delivers via ssh piping the envelope to stdin, true on exit 0', async () => {
        const dir = await tempDir();
        await seedRemote(dir);
        const rec = recordingRunner(0);

        const t = await resolveTransport({ configDir: dir, runner: rec.run });
        const envelope = '{"schema_version":"uc.event.v1"}';
        const delivered = await t.deliver(envelope);

        assert.equal(delivered, true);
        assert.equal(rec.calls.length, 1);
        assert.equal(rec.calls[0].program, 'ssh');
        assert.deepEqual(rec.calls[0].args, ['fabio@mini', 'uc event commit --from-stdin']);
        assert.equal(rec.calls[0].stdin, envelope);
    });

    // a nonzero ssh exit (uc missing on the hub) → deliver false (stays pending)
    it('returns false when ssh exits nonzero', async () => {
        const dir = await tempDir();
        await seedRemote(dir);
        const rec = recordingRunner(127);

        const t = await resolveTransport({ configDir: dir, runner: rec.run });
        const delivered = await t.deliver('{"schema_version":"uc.event.v1"}');

        assert.equal(delivered, false);
    });
});
