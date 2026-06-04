// =============================================================================
// transport.test — hub resolution + the SSH Deliver. Drives a temp sync config
// dir and an INJECTED CommandRunner (no real SSH). Asserts: local config →
// localMode + target 'local'; remote config → target = the ssh host + a Deliver
// that pipes the envelope JSON to `ssh <host> 'uc event commit --from-stdin'`,
// resolving true on exit 0 and false (stays pending) on nonzero.
// =============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, type Config, type CommandResult } from '@ultracontext/sync';

import { resolveTransport, buildTailArgs, remoteTail, SSH_HARDENING, loginShellWrap } from './transport';
import { writeRemote } from '../remote';
import { startServer, type ServeHandle } from '../serve/server';
import { tempDbUrl, cleanupTempDbs } from '../testing/temp-db';

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
        // BUG 2: the remote uc runs inside a LOGIN shell so ~/.local/bin is on PATH
        // (a non-login ssh shell excludes it → `uc: command not found`, exit 127).
        // The hardening flags still lead, so an unreachable hub fails fast.
        assert.deepEqual(rec.calls[0].args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event commit --from-stdin')]);
        // the wrapping is exactly `bash -lc "uc event commit --from-stdin"`
        assert.equal(rec.calls[0].args.at(-1), 'bash -lc "uc event commit --from-stdin"');
        assert.equal(rec.calls[0].stdin, envelope);
    });

    // the ssh transport exposes a tail that runs the documented ssh argv (the
    // selection: with NO api coord, an ssh target tails over ssh, unchanged)
    it('tails over ssh through the transport seam', async () => {
        const dir = await tempDir();
        await seedRemote(dir);
        const calls: { program: string; args: string[] }[] = [];
        const runner = async (program: string, args: string[]): Promise<CommandResult> => {
            calls.push({ program, args });
            return { code: 0, stdout: '{"event_id":"evt_ssh_tail"}\n', stderr: '' };
        };

        const t = await resolveTransport({ configDir: dir, runner });
        assert.ok(t.tail, 'an ssh transport exposes a tail');
        const result = await t.tail!({ limit: 3 });

        assert.equal(result.ok, true);
        assert.deepEqual(result.lines, ['{"event_id":"evt_ssh_tail"}']);
        assert.equal(calls[0].program, 'ssh');
        assert.deepEqual(calls[0].args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event tail --json --limit 3')]);
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

// -- http mode (api coord present) --------------------------------------------

describe('resolveTransport (api coord present → HTTP)', () => {
    // an in-process `uc serve` the HTTP transport delivers + tails against
    let server: ServeHandle;
    const httpDirs: string[] = [];

    before(async () => {
        server = await startServer({ port: 0, host: '127.0.0.1', dbUrl: tempDbUrl(), configDir: await tempDir() });
    });
    after(async () => {
        await server.close();
        cleanupTempDbs();
    });

    // seed a config dir that carries an api coord pointing at the serve endpoint
    async function seedApi(): Promise<string> {
        const dir = await tempDir();
        httpDirs.push(dir);
        // a 'local' sync side (no ssh) + an api coord → the api leg must win
        await saveConfig({ remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] }, dir);
        await writeRemote({ api: { baseUrl: server.url, apiKey: server.key! } }, dir);
        return dir;
    }

    // an api coord → remote mode (NOT local), target = the api base url
    it('reports remote mode targeting the api base url', async () => {
        const dir = await seedApi();

        const t = await resolveTransport({ configDir: dir });

        assert.equal(t.localMode, false);
        assert.equal(t.target, server.url);
    });

    // deliver POSTs the envelope to /events over HTTP → committed, returns true
    it('delivers an event over HTTP and tails it back', async () => {
        const dir = await seedApi();
        const t = await resolveTransport({ configDir: dir });

        // the envelope a flusher would hand the transport (the row's exact JSON)
        const envelope = JSON.stringify({
            schema_version: 'uc.event.v1',
            event_id: 'evt_http_transport_1',
            kind: 'http.transport.test',
            source: 'transport-test',
            subject: 'demo',
            occurred_at: new Date().toISOString(),
            host: 'laptop',
            privacy: 'internal',
        });

        // POST /events committed the envelope → true
        const delivered = await t.deliver(envelope);
        assert.equal(delivered, true);

        // GET /events read it back through the transport's own tail
        assert.ok(t.tail, 'an HTTP transport exposes a tail');
        const result = await t.tail!({ kind: 'http.transport.test' });
        assert.equal(result.ok, true);
        assert.ok(result.lines.some((l) => l.includes('evt_http_transport_1')));
    });

    // a bad bearer (wrong key) → deliver false (the row stays pending)
    it('returns false when the api rejects the bearer', async () => {
        const dir = await tempDir();
        await saveConfig({ remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] }, dir);
        await writeRemote({ api: { baseUrl: server.url, apiKey: 'uc_wrong_key' } }, dir);

        const t = await resolveTransport({ configDir: dir });
        const delivered = await t.deliver('{"schema_version":"uc.event.v1","event_id":"evt_bad"}');

        assert.equal(delivered, false);
    });

    // the selection rule: api coord present WINS over an ssh target (HTTP, not ssh)
    it('prefers the api coord even when an ssh target is also set', async () => {
        const dir = await tempDir();
        httpDirs.push(dir);
        // BOTH an ssh remote AND an api coord configured → HTTP must win
        await saveConfig({ remote: 'fabio@mini', remoteRoot: '~/.ultracontext', hostId: 'laptop', sources: [] }, dir);
        await writeRemote({ api: { baseUrl: server.url, apiKey: server.key! } }, dir);

        const rec = recordingRunner(0);
        const t = await resolveTransport({ configDir: dir, runner: rec.run });

        // target is the api url (not the ssh host) and deliver never touches ssh
        assert.equal(t.target, server.url);
        await t.deliver('{"schema_version":"uc.event.v1","event_id":"evt_pref"}');
        assert.equal(rec.calls.length, 0, 'the ssh runner is never called when an api coord is set');
    });
});

// -- buildTailArgs (remote tail argv) -----------------------------------------

describe('buildTailArgs', () => {
    // the ssh argv leads with the hardening flags, then target + the LOGIN-shell
    // wrapped fixed invocation (BUG 2: ~/.local/bin must be on the remote PATH).
    it('builds `ssh <hardening> <target> "bash -lc \\"uc event tail --json\\""` with no filters', () => {
        const args = buildTailArgs('fabio@mini', {});
        assert.deepEqual(args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event tail --json')]);
        assert.equal(args.at(-1), 'bash -lc "uc event tail --json"');
    });

    // the hardening flags pin BatchMode (no password prompt) + a bounded ConnectTimeout
    it('leads with BatchMode=yes and a ConnectTimeout (no hang on an unreachable hub)', () => {
        const joined = SSH_HARDENING.join(' ');
        assert.match(joined, /BatchMode=yes/);
        assert.match(joined, /ConnectTimeout=\d+/);
    });

    // limit + every filter land on the remote command in a fixed order, inside
    // the login-shell wrapping (the validated tokens are composed safely within it)
    it('appends --limit and the kind/source/subject filters', () => {
        const args = buildTailArgs('fabio@mini', { limit: 5, kind: 'a.b.c', source: 'drv', subject: 'claude:s:1' });
        assert.deepEqual(args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event tail --json --limit 5 --kind a.b.c --source drv --subject claude:s:1')]);
        assert.equal(args.at(-1), 'bash -lc "uc event tail --json --limit 5 --kind a.b.c --source drv --subject claude:s:1"');
    });

    // a non-integer limit is rejected (no NaN leaking into the remote command)
    it('rejects a non-integer limit', () => {
        assert.throws(() => buildTailArgs('fabio@mini', { limit: 1.5 }), /limit/);
    });

    // a filter value carrying a shell metachar is rejected (injection guard)
    it('rejects a subject with shell metacharacters', () => {
        assert.throws(() => buildTailArgs('fabio@mini', { subject: 'x; rm -rf /' }), /subject/);
    });

    // a filter value with a quote is rejected (injection guard)
    it('rejects a kind with a quote', () => {
        assert.throws(() => buildTailArgs('fabio@mini', { kind: 'a"b' }), /kind/);
    });

    // a filter value with whitespace is rejected (outside the token charset)
    it('rejects a source with whitespace', () => {
        assert.throws(() => buildTailArgs('fabio@mini', { source: 'a b' }), /source/);
    });

    // BUG 2: an injection attempt in a filter is rejected by the charset guard
    // BEFORE it could ever reach the (now login-shell wrapped) remote command.
    it('rejects an injection-attempt filter before wrapping it into the login shell', () => {
        assert.throws(() => buildTailArgs('fabio@mini', { subject: 'x"; rm -rf /; echo "' }), /subject/);
    });
});

// -- loginShellWrap (BUG 2: remote PATH via a login shell) --------------------

describe('loginShellWrap', () => {
    // wrap the remote uc invocation in a LOGIN shell so the user's PATH
    // (~/.local/bin via ~/.profile) is loaded — a non-login ssh shell omits it.
    it('wraps a command as `bash -lc "<command>"`', () => {
        assert.equal(loginShellWrap('uc event commit --from-stdin'), 'bash -lc "uc event commit --from-stdin"');
    });

    // the wrapped command is one safe double-quoted string (the inner uc + its
    // already-charset-validated flags compose inside it without breaking out).
    it('double-quotes the inner invocation', () => {
        const wrapped = loginShellWrap('uc event tail --json --kind a.b.c');
        assert.match(wrapped, /^bash -lc "uc event tail --json --kind a\.b\.c"$/);
    });
});

// -- remoteTail (run over ssh) ------------------------------------------------

describe('remoteTail', () => {
    // success: returns the hub's stdout split into trimmed line-JSON strings
    it('runs ssh and returns the hub stdout lines on exit 0', async () => {
        const calls: { program: string; args: string[] }[] = [];
        const runner = async (program: string, args: string[]): Promise<CommandResult> => {
            calls.push({ program, args });
            return { code: 0, stdout: '{"event_id":"evt_a"}\n{"event_id":"evt_b"}\n', stderr: '' };
        };

        const result = await remoteTail('fabio@mini', { limit: 2 }, runner);

        assert.equal(result.ok, true);
        assert.deepEqual(result.lines, ['{"event_id":"evt_a"}', '{"event_id":"evt_b"}']);
        assert.equal(calls[0].program, 'ssh');
        assert.deepEqual(calls[0].args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event tail --json --limit 2')]);
    });

    // empty hub log → ok with zero lines (not an error)
    it('returns ok with no lines when the hub log is empty', async () => {
        const runner = async (): Promise<CommandResult> => ({ code: 0, stdout: '\n', stderr: '' });
        const result = await remoteTail('fabio@mini', {}, runner);
        assert.equal(result.ok, true);
        assert.deepEqual(result.lines, []);
    });

    // a nonzero ssh exit → ok false, carrying the code + stderr for the caller
    it('reports ok false with the exit code + stderr on a nonzero exit', async () => {
        const runner = async (): Promise<CommandResult> => ({ code: 255, stdout: '', stderr: 'ssh: connect: host down' });
        const result = await remoteTail('fabio@mini', {}, runner);
        assert.equal(result.ok, false);
        assert.equal(result.code, 255);
        assert.match(result.stderr, /host down/);
    });
});
