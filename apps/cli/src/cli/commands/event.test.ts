// =============================================================================
// event.test — the TOP-LEVEL `uc event` family. Drives the action functions AND
// REAL argv (buildEventCommand().parseAsync) against a TEMP sqlite FILE (libsql
// :memory: doesn't share tables across connections) + a temp sync config dir +
// a FAKE ssh runner. Covers: emit→tail→status→flush round-trip in LOCAL mode;
// pending→flush with a fake runner (success + failure); commit --from-stdin via
// injected stdin (valid / invalid / duplicate → committed:0); k=v parse errors;
// and that tail ALWAYS emits one compact JSON envelope per line.
// =============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, type Config, type CommandResult } from '@ultracontext/sync';

import { SSH_HARDENING, loginShellWrap } from '../../../lib/events/transport';
import { writeRemote } from '../../../lib/remote';
import { startServer, type ServeHandle } from '../../../lib/serve/server';
import {
    emitAction,
    tailAction,
    statusAction,
    flushAction,
    commitAction,
    buildEventCommand,
} from './event';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// a fresh temp db url (a real FILE — :memory: can't share tables across opens)
async function tempDbUrl(): Promise<string> {
    const dir = await tempDir('uc-cli-event-db-');
    return 'file:' + join(dir, 'uc.db');
}

// -- capture + fakes ----------------------------------------------------------

// a writable-like sink recording everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// seed a local-target sync config in a fresh temp config dir
async function localConfigDir(): Promise<string> {
    const dir = await tempDir('uc-cli-event-cfg-');
    const config: Config = { remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] };
    await saveConfig(config, dir);
    return dir;
}

// seed a remote (ssh) sync config in a fresh temp config dir
async function remoteConfigDir(): Promise<string> {
    const dir = await tempDir('uc-cli-event-cfg-');
    const config: Config = { remote: 'fabio@mini', remoteRoot: '~/.ultracontext', hostId: 'laptop', sources: [] };
    await saveConfig(config, dir);
    return dir;
}

// a fake ssh runner replying a canned exit code, recording each piped envelope
function fakeRunner(code: number) {
    const stdins: string[] = [];
    const run = async (_p: string, _a: string[], stdin?: string): Promise<CommandResult> => {
        if (stdin !== undefined) stdins.push(stdin);
        return { code, stdout: '', stderr: '' };
    };
    return { run, stdins };
}

// a fake ssh runner for the REMOTE TAIL path: records the exact argv, replies
// canned stdout + exit code (so a test asserts the hub invocation + verbatim out)
function fakeTailRunner(code: number, stdout: string, stderr = '') {
    const calls: { program: string; args: string[] }[] = [];
    const run = async (program: string, args: string[]): Promise<CommandResult> => {
        calls.push({ program, args });
        return { code, stdout, stderr };
    };
    return { run, calls };
}

// the base emit flags (kind/source/subject are required by the contract)
function emitFlags(over: Record<string, unknown> = {}) {
    return { kind: 'agent.run.completed', source: 'build-agent', subject: 'agent-run:build:1', ...over };
}

// -- emit → tail → status round-trip (local) ----------------------------------

describe('uc event emit/tail/status (local mode)', () => {
    // a local emit commits in-db; tail reads it back as one JSON line; status counts it
    it('round-trips emit → tail → status', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir, io: { stdout: sink(), stderr: sink(), isTTY: true } };

        // emit prints the bare event id (human mode)
        const emitOut = sink();
        const emitCode = await emitAction(emitFlags({ json: false }), { ...deps, io: { stdout: emitOut, stderr: sink(), isTTY: true } });
        assert.equal(emitCode, 0);
        assert.match(emitOut.text().trim(), /^evt_[0-9a-f]{24}$/);

        // tail emits exactly one compact JSON envelope line for the one event
        const tailOut = sink();
        const tailCode = await tailAction({ json: false }, { ...deps, io: { stdout: tailOut, stderr: sink(), isTTY: true } });
        assert.equal(tailCode, 0);
        const lines = tailOut.text().trim().split('\n');
        assert.equal(lines.length, 1);
        const env = JSON.parse(lines[0]);
        assert.equal(env.schema_version, 'uc.event.v1');
        assert.equal(env.kind, 'agent.run.completed');
        assert.equal(env.privacy, 'metadata_only'); // the documented default
        assert.ok(env.received_at, 'a local commit sets received_at');

        // status reports target local, host laptop, one committed, zero pending
        const statusOut = sink();
        const statusCode = await statusAction({ json: true }, { ...deps, io: { stdout: statusOut, stderr: sink(), isTTY: false } });
        assert.equal(statusCode, 0);
        const s = JSON.parse(statusOut.text());
        assert.equal(s.target, 'local');
        assert.equal(s.host, 'laptop');
        assert.equal(s.committed, 1);
        assert.equal(s.pending, 0);
    });

    // --json on emit prints the full envelope, not a bare id
    it('emit --json prints the envelope', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const out = sink();

        const code = await emitAction(emitFlags({ json: true }), { dbUrl, configDir, io: { stdout: out, stderr: sink(), isTTY: false } });

        assert.equal(code, 0);
        const env = JSON.parse(out.text());
        assert.equal(env.schema_version, 'uc.event.v1');
        assert.match(env.event_id, /^evt_/);
    });

    // tail honors --limit and returns chronological order (oldest-of-tail first)
    it('tail --limit returns the chronological tail', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir };

        // emit three with explicit ascending occurred_at
        for (const n of [1, 2, 3]) {
            await emitAction(emitFlags({ subject: `s:${n}`, occurredAt: `2026-06-0${n}T00:00:00.000Z`, json: true }), { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } });
        }

        const out = sink();
        await tailAction({ limit: 2, json: false }, { ...deps, io: { stdout: out, stderr: sink(), isTTY: true } });

        const lines = out.text().trim().split('\n').map((l) => JSON.parse(l));
        assert.equal(lines.length, 2);
        // chronological: the last two, oldest-of-the-tail first
        assert.equal(lines[0].subject, 's:2');
        assert.equal(lines[1].subject, 's:3');
    });

    // tail filters by kind
    it('tail --kind filters', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir };

        await emitAction(emitFlags({ kind: 'a.b.c', subject: 's:a', json: true }), { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } });
        await emitAction(emitFlags({ kind: 'x.y.z', subject: 's:b', json: true }), { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        await tailAction({ kind: 'x.y.z', json: false }, { ...deps, io: { stdout: out, stderr: sink(), isTTY: true } });

        const lines = out.text().trim().split('\n').map((l) => JSON.parse(l));
        assert.equal(lines.length, 1);
        assert.equal(lines[0].kind, 'x.y.z');
    });
});

// -- emit validation + k=v parsing --------------------------------------------

describe('uc event emit validation', () => {
    // an illegal kind (bad charset) → exit 1 with an error on stderr
    it('rejects an illegal kind', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await emitAction(emitFlags({ kind: 'bad kind!', json: true }), { dbUrl, configDir, io: { stdout: sink(), stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /kind/);
    });

    // a non-integer --count value → exit 1 with a flag-named error
    it('rejects a non-integer --count', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await emitAction(emitFlags({ count: ['x=abc'], json: true }), { dbUrl, configDir, io: { stdout: sink(), stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /--count/);
    });

    // a malformed --label pair (no =) → exit 1 with a flag-named error
    it('rejects a --label without =', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await emitAction(emitFlags({ label: ['oops'], json: true }), { dbUrl, configDir, io: { stdout: sink(), stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /--label/);
    });

    // counts + labels land on the committed envelope
    it('carries counts + labels onto the envelope', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();

        await emitAction(emitFlags({ count: ['listed=10', 'changed=1'], label: ['app=claude'], json: true }), { dbUrl, configDir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        await tailAction({ json: true }, { dbUrl, configDir, io: { stdout: out, stderr: sink(), isTTY: false } });
        const env = JSON.parse(out.text().trim());
        assert.deepEqual(env.counts, { listed: 10, changed: 1 });
        assert.deepEqual(env.labels, { app: 'claude' });
    });
});

// -- relay compat: --event-id + --error-* (BUG 4) -----------------------------

describe('uc event emit — relay compat flags (BUG 4)', () => {
    // the live iOS relay passes its OWN idempotency id via --event-id; the emitted
    // (and tailed) envelope must carry that exact id, NOT a freshly generated one.
    it('honors a caller-provided --event-id end to end', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir };

        const emitOut = sink();
        const code = await emitAction(emitFlags({ eventId: 'evt_fixed_1', json: false }), { ...deps, io: { stdout: emitOut, stderr: sink(), isTTY: true } });
        assert.equal(code, 0);
        // emit echoes the provided id (human mode prints the bare id)
        assert.equal(emitOut.text().trim(), 'evt_fixed_1');

        // the tailed envelope carries that exact event_id
        const tailOut = sink();
        await tailAction({ json: true }, { ...deps, io: { stdout: tailOut, stderr: sink(), isTTY: false } });
        assert.equal(JSON.parse(tailOut.text().trim()).event_id, 'evt_fixed_1');
    });

    // a second emit with the SAME --event-id dedupes (relay idempotency holds):
    // committed:0, and the committed log still has exactly one row.
    it('dedupes a second emit with the same --event-id (committed:0)', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir };

        // first emit lands
        await emitAction(emitFlags({ eventId: 'evt_idem_1', json: true }), { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        // a re-emit of the same id → status still reports ONE committed row
        await emitAction(emitFlags({ eventId: 'evt_idem_1', json: true }), { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        await statusAction({ json: true }, { ...deps, io: { stdout: out, stderr: sink(), isTTY: false } });
        assert.equal(JSON.parse(out.text()).committed, 1);
    });

    // the relay's historical error events: --error-class/-message/-retryable
    // assemble into the envelope's error object {class,message,retryable}.
    it('assembles --error-class/-message/-retryable into the error object', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const deps = { dbUrl, configDir };

        await emitAction(
            emitFlags({ ok: false, errorClass: 'SyncError', errorMessage: 'boom', errorRetryable: true, json: true }),
            { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: false } },
        );

        const out = sink();
        await tailAction({ json: true }, { ...deps, io: { stdout: out, stderr: sink(), isTTY: false } });
        const env = JSON.parse(out.text().trim());
        assert.deepEqual(env.error, { class: 'SyncError', message: 'boom', retryable: true });
        assert.equal(env.ok, false);
    });

    // --event-id is charset/length validated like any token (no injection / junk id)
    it('rejects an illegal --event-id', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await emitAction(emitFlags({ eventId: 'bad id!', json: true }), { dbUrl, configDir, io: { stdout: sink(), stderr: errs, isTTY: false } });
        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /event_id/);
    });
});

// -- remote pending → flush ---------------------------------------------------

describe('uc event flush (remote mode)', () => {
    // a remote emit with a reachable hub delivers immediately → status sent
    it('emit delivers immediately when the hub is reachable', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();
        const runner = fakeRunner(0);

        const code = await emitAction(emitFlags({ json: true }), { dbUrl, configDir, runner: runner.run, io: { stdout: sink(), stderr: sink(), isTTY: false } });
        assert.equal(code, 0);
        assert.equal(runner.stdins.length, 1); // it piped the envelope over ssh

        // status: zero pending, one sent
        const out = sink();
        await statusAction({ json: true }, { dbUrl, configDir, runner: runner.run, io: { stdout: out, stderr: sink(), isTTY: false } });
        const s = JSON.parse(out.text());
        assert.equal(s.target, 'fabio@mini');
        assert.equal(s.pending, 0);
        assert.equal(s.committed, 1); // a remote sent row counts as committed (reached the hub)
    });

    // a remote emit with an UNREACHABLE hub stays pending → flush retries → sent
    it('queues pending when the hub is down, then flush delivers', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();

        // emit while ssh fails (exit 127) → the row stays pending
        const down = fakeRunner(127);
        await emitAction(emitFlags({ json: true }), { dbUrl, configDir, runner: down.run, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const beforeOut = sink();
        await statusAction({ json: true }, { dbUrl, configDir, runner: down.run, io: { stdout: beforeOut, stderr: sink(), isTTY: false } });
        assert.equal(JSON.parse(beforeOut.text()).pending, 1);

        // a failing flush → flushed 0, exit 1, the row stays pending
        const failOut = sink();
        const failCode = await flushAction({ json: true }, { dbUrl, configDir, runner: down.run, io: { stdout: failOut, stderr: sink(), isTTY: false } });
        assert.equal(failCode, 1);
        assert.equal(JSON.parse(failOut.text()).flushed, 0);
        assert.equal(JSON.parse(failOut.text()).failed, 1);

        // now the hub is back (exit 0) → flush delivers, exit 0, pending → 0
        const up = fakeRunner(0);
        const okOut = sink();
        const okCode = await flushAction({ json: true }, { dbUrl, configDir, runner: up.run, io: { stdout: okOut, stderr: sink(), isTTY: false } });
        assert.equal(okCode, 0);
        assert.equal(JSON.parse(okOut.text()).flushed, 1);
        assert.equal(up.stdins.length, 1);

        const afterOut = sink();
        await statusAction({ json: true }, { dbUrl, configDir, runner: up.run, io: { stdout: afterOut, stderr: sink(), isTTY: false } });
        assert.equal(JSON.parse(afterOut.text()).pending, 0);
        assert.equal(JSON.parse(afterOut.text()).committed, 1); // delivered → sent → counts as committed
    });

    // tail is the COMMITTED log: a remote emit that stays pending must NOT surface
    // in tail (it never reached a hub; received_at is absent until commit).
    it('tail excludes a pending (undelivered) remote event', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();

        // emit while ssh fails → the row is queued pending, never committed
        const down = fakeRunner(127);
        await emitAction(emitFlags({ json: true }), { dbUrl, configDir, runner: down.run, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        // tail shows nothing — the committed log is empty
        const out = sink();
        await tailAction({ json: false }, { dbUrl, configDir, runner: down.run, io: { stdout: out, stderr: sink(), isTTY: true } });
        assert.equal(out.text().trim(), '');
    });
});

// -- remote tail (reads the HUB log over ssh) ---------------------------------

describe('uc event tail (remote mode)', () => {
    // a remote config → tail reads the HUB's canonical log over ssh, NOT the local
    // db; the hub stdout (already line-JSON) is emitted verbatim, with the filters
    // passed through to the fixed remote `uc event tail --json …` invocation.
    it('tails the hub over ssh, emitting its lines verbatim with filters', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();
        const hubLine = '{"schema_version":"uc.event.v1","event_id":"evt_hub_1","kind":"a.b.c"}';
        const runner = fakeTailRunner(0, hubLine + '\n');

        const out = sink();
        const code = await tailAction(
            { limit: 5, kind: 'a.b.c', source: 'drv', subject: 'claude:s:1', json: false },
            { dbUrl, configDir, runner: runner.run, io: { stdout: out, stderr: sink(), isTTY: true } },
        );

        assert.equal(code, 0);
        // the hub line is emitted exactly as received (verbatim consumer contract)
        assert.equal(out.text().trim(), hubLine);
        // the ssh invocation carries every filter on the fixed remote command,
        // login-shell wrapped (BUG 2: ~/.local/bin on the remote PATH)
        assert.equal(runner.calls.length, 1);
        assert.equal(runner.calls[0].program, 'ssh');
        assert.deepEqual(runner.calls[0].args, [...SSH_HARDENING, 'fabio@mini', loginShellWrap('uc event tail --json --limit 5 --kind a.b.c --source drv --subject claude:s:1')]);
    });

    // a local emit on the SAME machine must NOT surface in remote tail — remote
    // tail reads the hub, never the local db (closes the consumer gap honestly).
    it('does not read the local db in remote mode', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();

        // a local row exists in the db (an undelivered/local artifact)
        await emitAction(emitFlags({ subject: 'local:only', json: true }), { dbUrl, configDir, runner: fakeRunner(0).run, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        // the hub returns its OWN (different) log
        const hubLine = '{"event_id":"evt_hub_only","kind":"x.y.z"}';
        const runner = fakeTailRunner(0, hubLine + '\n');

        const out = sink();
        await tailAction({ json: false }, { dbUrl, configDir, runner: runner.run, io: { stdout: out, stderr: sink(), isTTY: true } });

        // only the hub line — the local 'local:only' row never appears
        assert.equal(out.text().trim(), hubLine);
    });

    // ssh failure (hub down / `uc` missing there) → exit 1 + a clear stderr error
    // naming the hub. NO silent fallback to the local db (honesty over magic).
    it('exits 1 with a hub-named error when ssh fails (no fallback)', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();
        const runner = fakeTailRunner(255, '', 'ssh: connect to host mini: Connection refused');

        const out = sink();
        const errs = sink();
        const code = await tailAction({ json: true }, { dbUrl, configDir, runner: runner.run, io: { stdout: out, stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.equal(out.text().trim(), ''); // no fallback output
        const err = JSON.parse(errs.text()).error;
        assert.match(err, /fabio@mini/); // names the hub target
    });

    // --local forces reading the LOCAL db even when a remote hub is configured
    // (the emitter's own debug view, e.g. on the hub itself); ssh is never invoked.
    it('--local forces the local db and never invokes ssh', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();

        // seed a COMMITTED local row directly via commit (the hub-side committed log)
        const envelope = JSON.stringify({
            schema_version: 'uc.event.v1', event_id: 'evt_local_view', kind: 'a.b.c', source: 's',
            subject: 'local:view', occurred_at: '2026-06-03T00:00:00.000Z', host: 'mini', privacy: 'metadata_only',
        });
        await commitAction({ fromStdin: true, json: false }, { dbUrl, configDir, stdin: async () => envelope, runner: fakeRunner(0).run, io: { stdout: sink(), stderr: sink(), isTTY: true } });

        const runner = fakeTailRunner(0, 'SHOULD-NOT-BE-USED\n');
        const out = sink();
        const code = await tailAction({ local: true, json: false }, { dbUrl, configDir, runner: runner.run, io: { stdout: out, stderr: sink(), isTTY: true } });

        assert.equal(code, 0);
        assert.equal(runner.calls.length, 0); // ssh never invoked
        const env = JSON.parse(out.text().trim());
        assert.equal(env.subject, 'local:view'); // the local row, read from the db
    });

    // a filter value carrying a shell-injection attempt is rejected (exit 1),
    // never interpolated into the remote command.
    it('rejects a subject with an injection attempt before any ssh call', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await remoteConfigDir();
        const runner = fakeTailRunner(0, '');

        const errs = sink();
        const code = await tailAction(
            { subject: 'x; rm -rf /', json: true },
            { dbUrl, configDir, runner: runner.run, io: { stdout: sink(), stderr: errs, isTTY: false } },
        );

        assert.equal(code, 1);
        assert.equal(runner.calls.length, 0); // rejected before any ssh
        assert.match(JSON.parse(errs.text()).error, /subject/);
    });
});

// -- remote events over HTTP (api coord → POST/GET /events) -------------------

describe('uc event emit/tail (api coord → HTTP)', () => {
    // an in-process `uc serve` the emit POSTs to + the tail GETs from
    let server: ServeHandle;

    before(async () => {
        server = await startServer({ port: 0, host: '127.0.0.1', dbUrl: await tempDbUrl(), configDir: await tempDir('uc-cli-event-serve-') });
    });
    after(async () => { await server.close(); });

    // a config dir carrying an api coord pointing at the serve endpoint (no ssh)
    async function apiConfigDir(): Promise<string> {
        const dir = await tempDir('uc-cli-event-cfg-');
        await saveConfig({ remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] }, dir);
        await writeRemote({ api: { baseUrl: server.url, apiKey: server.key! } }, dir);
        return dir;
    }

    // emit (remote, api coord) → committed over HTTP → tail reads it back over HTTP
    it('emits over HTTP and tails it back over HTTP', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await apiConfigDir();

        // emit a remote event — the row queues pending, then delivers via POST /events
        const emitOut = sink();
        const emitCode = await emitAction(
            emitFlags({ subject: 'http:flow:1', json: true }),
            { dbUrl, configDir, io: { stdout: emitOut, stderr: sink(), isTTY: false } },
        );
        assert.equal(emitCode, 0);
        const emitted = JSON.parse(emitOut.text().trim());

        // tail reads the HUB's committed log over HTTP GET /events (NOT the local db)
        const tailOut = sink();
        const tailCode = await tailAction(
            { source: 'build-agent', json: false },
            { dbUrl, configDir, io: { stdout: tailOut, stderr: sink(), isTTY: true } },
        );
        assert.equal(tailCode, 0);

        // the tail line is the same envelope the emit delivered (one JSON per line)
        const lines = tailOut.text().trim().split('\n').filter(Boolean);
        assert.ok(lines.some((l) => JSON.parse(l).event_id === emitted.event_id));
    });

    // a remote tail when the api is unreachable → exit 1 naming the target (no fallback)
    it('exits 1 when the api hub is unreachable (no local fallback)', async () => {
        const dir = await tempDir('uc-cli-event-cfg-');
        await saveConfig({ remote: 'local', remoteRoot: join(dir, 'remote'), hostId: 'laptop', sources: [] }, dir);
        // point at a dead endpoint so GET /events fails at the network layer
        await writeRemote({ api: { baseUrl: 'http://127.0.0.1:1', apiKey: 'uc_x' } }, dir);

        const out = sink();
        const errs = sink();
        const code = await tailAction({ json: true }, { dbUrl: await tempDbUrl(), configDir: dir, io: { stdout: out, stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.equal(out.text().trim(), ''); // no fallback output
        assert.match(JSON.parse(errs.text()).error, /127\.0\.0\.1:1/); // names the api target
    });
});

// -- commit --from-stdin (hub side) -------------------------------------------

describe('uc event commit --from-stdin', () => {
    // a valid piped envelope → committed: 1, with received_at set
    it('commits a valid envelope (committed: 1)', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const envelope = JSON.stringify({
            schema_version: 'uc.event.v1', event_id: 'evt_commit_1', kind: 'a.b.c', source: 's',
            subject: 'sub', occurred_at: '2026-06-03T00:00:00.000Z', host: 'mini', privacy: 'metadata_only',
        });
        const out = sink();

        const code = await commitAction(
            { fromStdin: true, json: false },
            { dbUrl, configDir, stdin: async () => envelope, io: { stdout: out, stderr: sink(), isTTY: true } },
        );

        assert.equal(code, 0);
        assert.equal(out.text().trim(), 'committed: 1');
    });

    // a DUPLICATE event_id → committed: 0 (idempotent, NOT an error)
    it('is idempotent on a duplicate (committed: 0)', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const envelope = JSON.stringify({
            schema_version: 'uc.event.v1', event_id: 'evt_dup_1', kind: 'a.b.c', source: 's',
            subject: 'sub', occurred_at: '2026-06-03T00:00:00.000Z', host: 'mini', privacy: 'metadata_only',
        });
        const deps = { dbUrl, configDir, stdin: async () => envelope };

        // first commit lands
        await commitAction({ fromStdin: true, json: false }, { ...deps, io: { stdout: sink(), stderr: sink(), isTTY: true } });

        // second commit of the SAME event_id → committed: 0, exit 0
        const out = sink();
        const code = await commitAction({ fromStdin: true, json: false }, { ...deps, io: { stdout: out, stderr: sink(), isTTY: true } });
        assert.equal(code, 0);
        assert.equal(out.text().trim(), 'committed: 0');
    });

    // an invalid (malformed JSON) envelope → exit 1 with an error on stderr
    it('rejects invalid JSON', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await commitAction(
            { fromStdin: true, json: true },
            { dbUrl, configDir, stdin: async () => 'not json', io: { stdout: sink(), stderr: errs, isTTY: false } },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /JSON/);
    });

    // an envelope failing the contract → exit 1 (invalid_input)
    it('rejects an envelope that fails the contract', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();
        const bad = JSON.stringify({ schema_version: 'uc.event.v1', event_id: 'evt_x', kind: 'k' }); // missing fields

        const code = await commitAction(
            { fromStdin: true, json: true },
            { dbUrl, configDir, stdin: async () => bad, io: { stdout: sink(), stderr: errs, isTTY: false } },
        );

        assert.equal(code, 1);
    });

    // commit WITHOUT --from-stdin → a clear usage error
    it('requires --from-stdin', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();
        const errs = sink();

        const code = await commitAction({ json: true }, { dbUrl, configDir, io: { stdout: sink(), stderr: errs, isTTY: false } });

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /--from-stdin/);
    });
});

// -- REAL argv (parseAsync) ---------------------------------------------------

describe('buildEventCommand (real argv)', () => {
    // the group registers every documented subcommand
    it('registers emit/tail/status/flush/commit', () => {
        const event = buildEventCommand();
        const subs = event.commands.map((c) => c.name());
        for (const expected of ['emit', 'tail', 'status', 'flush', 'commit']) {
            assert.ok(subs.includes(expected), `missing event subcommand: ${expected}`);
        }
    });

    // emit's required flags are enforced by Commander (missing --kind throws)
    it('emit requires --kind/--source/--subject', () => {
        const emit = buildEventCommand().commands.find((c) => c.name() === 'emit');
        const mandatory = emit?.options.filter((o) => o.mandatory).map((o) => o.long) ?? [];
        assert.deepEqual(mandatory.sort(), ['--kind', '--source', '--subject']);
    });

    // BUG 4: emit registers the full 2.0 relay flag surface (the relay calls these)
    it('emit registers the full 2.0 relay flag surface', () => {
        const emit = buildEventCommand().commands.find((c) => c.name() === 'emit');
        const longs = emit?.options.map((o) => o.long) ?? [];
        for (const flag of [
            '--kind', '--source', '--subject', '--event-id', '--privacy', '--occurred-at',
            '--actor', '--run-id', '--trace-id', '--parent-event-id', '--priority', '--ok',
            '--payload-ref', '--payload-hash', '--count', '--label',
            '--error-class', '--error-message', '--error-retryable',
        ]) {
            assert.ok(longs.includes(flag), `missing emit flag: ${flag}`);
        }
    });

    // a full argv parse with --event-id + --error-* drives the relay path end to end
    it('parses `event emit … --event-id … --error-* …` argv end to end', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();

        const prevDb = process.env.UC_DB_URL;
        const prevHome = process.env.HOME;
        process.env.UC_DB_URL = dbUrl;
        process.env.HOME = await tempDir('uc-cli-event-home-');
        try {
            const event = buildEventCommand();
            await event.parseAsync(
                [
                    'emit', '--kind', 'a.b.c', '--source', 's', '--subject', 'sub',
                    '--event-id', 'evt_argv_1', '--ok', 'false',
                    '--error-class', 'E', '--error-message', 'boom', '--error-retryable', 'true',
                ],
                { from: 'user' },
            );

            // verify the row carries the provided id + the assembled error object
            const out = sink();
            await tailAction({ json: true }, { dbUrl, configDir, io: { stdout: out, stderr: sink(), isTTY: false } });
            const env = JSON.parse(out.text().trim());
            assert.equal(env.event_id, 'evt_argv_1');
            assert.deepEqual(env.error, { class: 'E', message: 'boom', retryable: true });
        } finally {
            if (prevDb === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = prevDb;
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
    });

    // a full argv parse of emit drives the handler end-to-end on a temp db
    it('parses `event emit … --count … --label …` argv end to end', async () => {
        const dbUrl = await tempDbUrl();
        const configDir = await localConfigDir();

        // env carries the temp db into the default resolution the argv path uses;
        // a temp $HOME means the default sync config is absent → local mode (no ssh)
        const prevDb = process.env.UC_DB_URL;
        const prevHome = process.env.HOME;
        process.env.UC_DB_URL = dbUrl;
        process.env.HOME = await tempDir('uc-cli-event-home-');
        try {
            const event = buildEventCommand();
            // commit prints to real stdout; we only assert the parse + insert succeed
            await event.parseAsync(
                ['emit', '--kind', 'a.b.c', '--source', 's', '--subject', 'sub', '--count', 'n=1', '--label', 'app=claude'],
                { from: 'user' },
            );

            // verify the row landed via the action path on the same temp db
            const out = sink();
            await tailAction({ json: true }, { dbUrl, configDir, io: { stdout: out, stderr: sink(), isTTY: false } });
            const env = JSON.parse(out.text().trim());
            assert.equal(env.kind, 'a.b.c');
            assert.deepEqual(env.counts, { n: 1 });
        } finally {
            if (prevDb === undefined) delete process.env.UC_DB_URL;
            else process.env.UC_DB_URL = prevDb;
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
    });
});
