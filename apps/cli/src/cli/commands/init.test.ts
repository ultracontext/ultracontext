// =============================================================================
// init.test — RED. `uc init` first-run onboarding. The interactive path uses
// @clack/prompts; the non-interactive path (--yes, or a piped/non-tty stdout)
// writes a default config without prompting. We TDD the non-interactive path:
// it must NEVER prompt, must persist a config via the injected writer, and must
// emit a machine-readable result. Optional --remote <baseUrl> / --api-key seed
// the hosted-backend slice. All io + persistence is injected (no real fs).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runInit, type InitDeps } from './init';

// -- harness ------------------------------------------------------------------

// a deps set whose writer records what init persisted; prompt throws if reached
function recordingDeps(overrides: Partial<InitDeps> = {}): { deps: InitDeps; written: () => unknown } {
    let saved: unknown;

    const deps: InitDeps = {
        // capture the persisted config slice
        saveConfig: async (cfg) => { saved = cfg; },
        // ensure the local db is initialized (no-op stub)
        ensureLocalDb: async () => {},
        // the non-interactive path must never call this
        prompt: async () => { throw new Error('prompt must not run in non-interactive mode'); },
        ...overrides,
    };

    return { deps, written: () => saved };
}

// run init with captured io
async function run(opts: Parameters<typeof runInit>[0], deps: InitDeps, json = true) {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        isTTY: !json,
    };

    const code = await runInit(opts, deps, { io });
    return { stdout, stderr, code };
}

// -- non-interactive: piped ---------------------------------------------------

describe('uc init (non-interactive)', () => {
    // a piped run (--json / non-tty) initializes without ever prompting
    it('initializes without prompting when piped', async () => {
        const { deps, written } = recordingDeps();

        const { code, stdout } = await run({ json: true }, deps);
        assert.equal(code, 0);

        // a config was persisted + a single JSON line was emitted
        assert.ok(written() !== undefined, 'config persisted');
        const out = JSON.parse(stdout.trim());
        assert.equal(out.ok, true);
    });

    // --yes forces the non-interactive path even on a tty
    it('does not prompt under --yes', async () => {
        const { deps } = recordingDeps();
        const { code } = await run({ yes: true }, deps, false);
        assert.equal(code, 0);
    });

    // the local db is initialized as part of onboarding
    it('initializes the local db', async () => {
        let ensured = false;
        const { deps } = recordingDeps({ ensureLocalDb: async () => { ensured = true; } });

        await run({ json: true }, deps);
        assert.equal(ensured, true);
    });

    // -- remote seeding -------------------------------------------------------

    // --remote + --api-key seed the persisted hosted-backend slice
    it('seeds remote credentials when provided', async () => {
        const { deps, written } = recordingDeps();

        await run({ json: true, remote: 'https://api.example.com', apiKey: 'sk-test' }, deps);

        const cfg = written() as { baseUrl?: string; apiKey?: string };
        assert.equal(cfg.baseUrl, 'https://api.example.com');
        assert.equal(cfg.apiKey, 'sk-test');
    });

    // with no remote flags, the persisted config carries no hosted credentials
    it('persists a local-only config by default', async () => {
        const { deps, written } = recordingDeps();

        await run({ json: true }, deps);

        const cfg = written() as { baseUrl?: string; apiKey?: string };
        assert.equal(cfg.baseUrl, undefined);
        assert.equal(cfg.apiKey, undefined);
    });

    // -- failure --------------------------------------------------------------

    // a persistence failure surfaces as a non-zero exit with stderr
    it('exits non-zero when persistence fails', async () => {
        const { deps } = recordingDeps({ saveConfig: async () => { throw new Error('disk full'); } });

        const { code, stdout, stderr } = await run({ json: true }, deps);
        assert.notEqual(code, 0);
        assert.equal(stdout.trim(), '', 'no data on stdout when init fails');
        assert.match(stderr, /\S/);
    });
});
