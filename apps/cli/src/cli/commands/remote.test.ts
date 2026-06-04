// =============================================================================
// remote.test — the top-level `uc remote <set|show|test|clear>`. Drives the
// testable action functions against a temp config dir + a FAKE ssh runner +
// an injected fetch, asserting the pipe-aware output (data → stdout JSON,
// status → stderr) and that `show` NEVER leaks the api key.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    remoteSetAction,
    remoteShowAction,
    remoteTestAction,
    remoteClearAction,
    buildRemoteCommand,
} from './remote';
import { readRemote, writeRemote } from '../../../lib/remote';
import { startServer, type ServeHandle } from '../../../lib/serve/server';
import { tempDbUrl, cleanupTempDbs } from '../../../lib/testing/temp-db';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-remote-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- capture helpers ----------------------------------------------------------

// a writable-like sink recording everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// a fake ssh runner replying a canned exit code (default ok) — never hits ssh
function fakeRunner(code = 0, stdout = '1.6.0\n') {
    return async () => ({ code, stdout, stderr: code === 0 ? '' : 'ssh: connect failed' });
}

// -- set ----------------------------------------------------------------------

describe('uc remote set', () => {
    // setting only the ssh target persists the ssh side (no api keys)
    it('sets the ssh side from a target', async () => {
        const dir = await tempDir();
        const out = sink();

        const code = await remoteSetAction(
            'user@vps',
            { json: true, root: '/srv/uc', hostId: 'laptop' },
            { configDir: dir, io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const remote = await readRemote(dir);
        assert.deepEqual(remote.ssh, { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' });
        assert.equal(remote.api, undefined);
    });

    // a bare target without --root gets the default root + a derived host id
    it('defaults the root and host id', async () => {
        const dir = await tempDir();

        const code = await remoteSetAction(
            'user@vps',
            { json: true },
            { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const remote = await readRemote(dir);
        assert.equal(remote.ssh?.target, 'user@vps');
        assert.equal(remote.ssh?.root, '~/.ultracontext');
        assert.ok(remote.ssh?.hostId, 'a host id is derived when none is given');
    });

    // setting only --api/--key (with `local` ssh) persists the api side
    it('sets the api side from --api/--key', async () => {
        const dir = await tempDir();

        const code = await remoteSetAction(
            'local',
            { json: true, api: 'https://api.example.com', key: 'sk_x' },
            { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const remote = await readRemote(dir);
        assert.deepEqual(remote.api, { baseUrl: 'https://api.example.com', apiKey: 'sk_x' });
    });

    // an api set AFTER an ssh set merges — both sides coexist
    it('merges api onto a prior ssh set', async () => {
        const dir = await tempDir();

        await remoteSetAction('user@vps', { json: true, hostId: 'laptop' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });
        await remoteSetAction('user@vps', { json: true, api: 'https://api.example.com', key: 'sk_x' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const remote = await readRemote(dir);
        assert.equal(remote.ssh?.target, 'user@vps');
        assert.equal(remote.api?.baseUrl, 'https://api.example.com');
    });

    // a `target:/root` spec splits into target + root
    it('parses a target:root spec', async () => {
        const dir = await tempDir();

        await remoteSetAction('user@vps:/srv/uc', { json: true, hostId: 'laptop' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const remote = await readRemote(dir);
        assert.equal(remote.ssh?.target, 'user@vps');
        assert.equal(remote.ssh?.root, '/srv/uc');
    });
});

// -- show ---------------------------------------------------------------------

describe('uc remote show', () => {
    // emits the unified remote, with keySet boolean — NEVER the raw key
    it('shows the unified remote and never leaks the key', async () => {
        const dir = await tempDir();
        await remoteSetAction('user@vps', { json: true, hostId: 'laptop', api: 'https://api.example.com', key: 'sk_secret_value' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        const code = await remoteShowAction({ json: true }, { configDir: dir, io: { stdout: out, stderr: sink(), isTTY: false } });

        assert.equal(code, 0);
        const text = out.text();
        // the key value must never appear anywhere in the output
        assert.ok(!text.includes('sk_secret_value'), 'show must NOT print the api key');

        const payload = JSON.parse(text);
        assert.equal(payload.data.ssh.target, 'user@vps');
        assert.equal(payload.data.api.baseUrl, 'https://api.example.com');
        assert.equal(payload.data.api.keySet, true);
    });

    // an empty remote shows both sides absent (no throw)
    it('shows an empty remote when nothing is configured', async () => {
        const dir = await tempDir();
        const out = sink();

        const code = await remoteShowAction({ json: true }, { configDir: dir, io: { stdout: out, stderr: sink(), isTTY: false } });

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        assert.equal(payload.data.ssh, null);
        assert.equal(payload.data.api, null);
    });
});

// -- test ---------------------------------------------------------------------

describe('uc remote test', () => {
    // a reachable ssh leg reports ok via the fake runner (no real ssh)
    it('reports the ssh leg ok when the runner exits 0', async () => {
        const dir = await tempDir();
        await remoteSetAction('user@vps', { json: true, hostId: 'laptop' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        const code = await remoteTestAction(
            { json: true },
            { configDir: dir, runner: fakeRunner(0), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        const ssh = payload.data.legs.find((l: { leg: string }) => l.leg === 'ssh');
        assert.equal(ssh.ok, true);
    });

    // a failing ssh leg (exit 255) surfaces ok:false + exit 1
    it('reports the ssh leg failing and exits 1', async () => {
        const dir = await tempDir();
        await remoteSetAction('user@vps', { json: true, hostId: 'laptop' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        const code = await remoteTestAction(
            { json: true },
            { configDir: dir, runner: fakeRunner(255), io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 1);
        const payload = JSON.parse(out.text());
        const ssh = payload.data.legs.find((l: { leg: string }) => l.leg === 'ssh');
        assert.equal(ssh.ok, false);
    });

    // the api leg health check uses the injected fetch against the base url
    it('reports the api leg ok via the injected fetch', async () => {
        const dir = await tempDir();
        await remoteSetAction('local', { json: true, api: 'https://api.example.com', key: 'sk_x' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        const fetchImpl = async () => ({ ok: true, status: 200 }) as Response;
        const code = await remoteTestAction(
            { json: true },
            { configDir: dir, fetch: fetchImpl as unknown as typeof fetch, io: { stdout: out, stderr: sink(), isTTY: false } },
        );

        assert.equal(code, 0);
        const payload = JSON.parse(out.text());
        const api = payload.data.legs.find((l: { leg: string }) => l.leg === 'api');
        assert.equal(api.ok, true);
    });

    // the api leg probes a REAL in-process serve over real fetch — `uc remote
    // test` exercises whichever transport is configured (here the HTTP api coord).
    it('reaches a real in-process uc serve over the api leg', async () => {
        const server = await startServer({ port: 0, host: '127.0.0.1', dbUrl: tempDbUrl(), configDir: await tempDir() });
        try {
            const dir = await tempDir();
            // persist the serve url+key as the api coord (no injected fetch — real)
            await writeRemote({ api: { baseUrl: server.url, apiKey: server.key! } }, dir);

            const out = sink();
            const code = await remoteTestAction(
                { json: true },
                { configDir: dir, io: { stdout: out, stderr: sink(), isTTY: false } },
            );

            assert.equal(code, 0);
            const api = JSON.parse(out.text()).data.legs.find((l: { leg: string }) => l.leg === 'api');
            assert.equal(api.ok, true);
        } finally {
            await server.close();
            cleanupTempDbs();
        }
    });

    // no remote configured at all → a clean exit-1 error
    it('exits 1 when no remote is configured', async () => {
        const dir = await tempDir();
        const errs = sink();

        const code = await remoteTestAction(
            { json: true },
            { configDir: dir, io: { stdout: sink(), stderr: errs, isTTY: false } },
        );

        assert.equal(code, 1);
        assert.match(JSON.parse(errs.text()).error, /no remote/i);
    });
});

// -- clear --------------------------------------------------------------------

describe('uc remote clear', () => {
    // clearing drops the remote coords and reports ok
    it('clears the remote coords', async () => {
        const dir = await tempDir();
        await remoteSetAction('user@vps', { json: true, hostId: 'laptop', api: 'https://api.example.com', key: 'sk_x' }, { configDir: dir, io: { stdout: sink(), stderr: sink(), isTTY: false } });

        const out = sink();
        const code = await remoteClearAction({ json: true }, { configDir: dir, io: { stdout: out, stderr: sink(), isTTY: false } });

        assert.equal(code, 0);
        assert.equal(JSON.parse(out.text()).ok, true);

        const remote = await readRemote(dir);
        assert.deepEqual(remote, {});
    });
});

// -- Commander wiring ---------------------------------------------------------

describe('buildRemoteCommand', () => {
    // the group registers set/show/test/clear
    it('registers set/show/test/clear', () => {
        const remote = buildRemoteCommand();
        const subs = remote.commands.map((c) => c.name());

        for (const expected of ['set', 'show', 'test', 'clear']) {
            assert.ok(subs.includes(expected), `missing remote subcommand: ${expected}`);
        }
    });
});
