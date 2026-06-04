// =============================================================================
// serve.test — the `uc serve` command surface, driven through a real argv parse
// (not handler-only). The server START is injected (a fake that records the
// resolved options + returns a handle) so the test asserts the option wiring +
// the pipe-aware output WITHOUT binding a socket. Covers: flags map to the start
// options (port/host/db/no-auth); the listening url + minted key print to STDERR
// (status stream); --json emits the url + keySet on STDOUT (data stream); the
// minted key is NEVER echoed under --json.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProgram } from '../main';
import { runServe, type ServeDeps } from './serve';

// -- captured io ---------------------------------------------------------------

// a writable sink that records everything written, for stdout/stderr assertions
function sink() {
    let text = '';
    return { write: (s: string) => { text += s; return true; }, get text() { return text; } };
}

// a fake start that records the options it was called with + returns a handle.
// noResolveClose makes close() resolve immediately (the real one releases a socket).
function fakeDeps(handle: Partial<{ url: string; port: number; key?: string; noAuth: boolean }> = {}) {
    const calls: { port: number; host: string; dbUrl: string; noAuth?: boolean }[] = [];
    const deps: ServeDeps = {
        start: async (opts) => {
            calls.push(opts);
            return {
                url: handle.url ?? `http://${opts.host}:${opts.port || 8787}`,
                port: handle.port ?? (opts.port || 8787),
                key: 'key' in handle ? handle.key : 'uc_live_minted_key',
                noAuth: handle.noAuth ?? Boolean(opts.noAuth),
                close: async () => {},
            };
        },
        // resolve immediately instead of running forever (the test never blocks)
        wait: async () => {},
    };
    return { deps, calls };
}

// -- option wiring -------------------------------------------------------------

describe('runServe option wiring', () => {
    // the flags map straight onto the start options
    it('maps --port/--host/--db/--no-auth onto the start options', async () => {
        const { deps, calls } = fakeDeps();
        const stdout = sink();
        const stderr = sink();

        await runServe({ port: 9090, host: '0.0.0.0', db: 'file:/tmp/x.db', noAuth: true }, deps, { io: { stdout, stderr, isTTY: true } });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].port, 9090);
        assert.equal(calls[0].host, '0.0.0.0');
        assert.equal(calls[0].dbUrl, 'file:/tmp/x.db');
        assert.equal(calls[0].noAuth, true);
    });

    // defaults: 127.0.0.1 + 8787 when the flags are omitted
    it('defaults host 127.0.0.1 and port 8787', async () => {
        const { deps, calls } = fakeDeps();
        await runServe({}, deps, { io: { stdout: sink(), stderr: sink(), isTTY: true } });

        assert.equal(calls[0].host, '127.0.0.1');
        assert.equal(calls[0].port, 8787);
    });

    // the --no-auth security warning must survive a PIPED (non-TTY) run — it is
    // not decorative, so it bypasses the TTY-gated status() and hits stderr always
    it('emits the --no-auth warning even when stderr is not a TTY', async () => {
        const { deps } = fakeDeps({ noAuth: true });
        const stderr = sink();
        await runServe({ noAuth: true }, deps, { io: { stdout: sink(), stderr, isTTY: false } });

        assert.match(stderr.text, /--no-auth/);
        assert.match(stderr.text, /unauthenticated/);
    });
});

// -- pipe-aware output ---------------------------------------------------------

describe('runServe output', () => {
    // human mode: the url + minted key print to STDERR (status stream), not stdout
    it('prints the url + minted key to stderr in human mode', async () => {
        const { deps } = fakeDeps({ url: 'http://127.0.0.1:8787', key: 'uc_live_secret' });
        const stdout = sink();
        const stderr = sink();

        await runServe({}, deps, { io: { stdout, stderr, isTTY: true } });

        assert.ok(stderr.text.includes('http://127.0.0.1:8787'));
        assert.ok(stderr.text.includes('uc_live_secret'));
    });

    // --json: the url + keySet land on STDOUT (the data stream stays secret-free);
    // the raw key still reaches STDERR (load-bearing, always delivered to the user).
    it('emits the url + keySet on stdout under --json, key only on stderr', async () => {
        const { deps } = fakeDeps({ url: 'http://127.0.0.1:8787', key: 'uc_live_secret' });
        const stdout = sink();
        const stderr = sink();

        await runServe({ json: true }, deps, { io: { stdout, stderr, isTTY: false } });

        const line = JSON.parse(stdout.text.trim());
        assert.equal(line.url, 'http://127.0.0.1:8787');
        assert.equal(line.keySet, true);
        // the secret never touches the data stream, but is delivered on stderr
        assert.ok(!stdout.text.includes('uc_live_secret'));
        assert.ok(stderr.text.includes('uc_live_secret'));
    });

    // a reused key (no fresh mint) prints no key line, just the url
    it('prints only the url when no key was minted', async () => {
        const { deps } = fakeDeps({ url: 'http://127.0.0.1:8787', key: undefined });
        const stderr = sink();

        await runServe({}, deps, { io: { stdout: sink(), stderr, isTTY: true } });

        assert.ok(stderr.text.includes('http://127.0.0.1:8787'));
        assert.ok(!stderr.text.includes('uc_live'));
    });
});

// -- command registration ------------------------------------------------------

describe('uc serve registration', () => {
    // the verb is registered on the root program
    it('is registered on the root program', () => {
        const program = buildProgram();
        assert.ok(program.commands.some((c) => c.name() === 'serve'));
    });
});
