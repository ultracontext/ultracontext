// =============================================================================
// upgrade.test — RED. `uc upgrade` self-updates the CLI. It (1) detects the
// install method (npm / brew / curl) from the resolved binary path, mapping to
// the right upgrade command, and (2) suppresses the proactive update *notice*
// in CI / pipes / --json (so it never pollutes machine output or logs). The
// explicit `uc upgrade` invocation always runs. All env + path + exec probes
// are injected so detection + suppression run with no real subprocess.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectInstallMethod, shouldSuppressNotice, runUpgrade, type UpgradeDeps } from './upgrade';

// -- install method detection -------------------------------------------------

describe('detectInstallMethod', () => {
    // a homebrew cellar path → brew
    it('detects brew from a Cellar path', () => {
        const m = detectInstallMethod('/opt/homebrew/Cellar/ultracontext/1.5.0/bin/uc');
        assert.equal(m.manager, 'brew');
        assert.match(m.command, /brew upgrade/);
    });

    // a global node_modules path → npm
    it('detects npm from a node_modules path', () => {
        const m = detectInstallMethod('/usr/local/lib/node_modules/ultracontext/dist/uc.mjs');
        assert.equal(m.manager, 'npm');
        assert.match(m.command, /npm install -g ultracontext/);
    });

    // anything else (a curl-installed standalone) → curl re-install
    it('falls back to curl for an unknown path', () => {
        const m = detectInstallMethod('/home/me/.ultracontext/bin/uc');
        assert.equal(m.manager, 'curl');
        assert.match(m.command, /curl/);
    });
});

// -- notice suppression -------------------------------------------------------

describe('shouldSuppressNotice', () => {
    // CI environments must never see the proactive notice
    it('suppresses under CI', () => {
        assert.equal(shouldSuppressNotice({ json: false, isTTY: true, env: { CI: 'true' } }), true);
    });

    // machine mode (--json) suppresses the notice
    it('suppresses when --json is set', () => {
        assert.equal(shouldSuppressNotice({ json: true, isTTY: true, env: {} }), true);
    });

    // a piped (non-tty) stdout suppresses the notice
    it('suppresses when stdout is piped', () => {
        assert.equal(shouldSuppressNotice({ json: false, isTTY: false, env: {} }), true);
    });

    // an interactive tty with no CI and no --json shows the notice
    it('allows the notice on an interactive tty', () => {
        assert.equal(shouldSuppressNotice({ json: false, isTTY: true, env: {} }), false);
    });
});

// -- handler ------------------------------------------------------------------

// a deps set that resolves to an npm install + a stubbed exec
function npmDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
    return {
        binPath: '/usr/local/lib/node_modules/ultracontext/dist/uc.mjs',
        version: '1.5.0',
        env: {},
        exec: async () => ({ code: 0 }),
        ...overrides,
    };
}

// run upgrade with captured io
async function run(deps: UpgradeDeps, json = true) {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        isTTY: !json,
    };

    const code = await runUpgrade({ json }, deps, { io });
    return { stdout, stderr, code };
}

describe('runUpgrade', () => {
    // an explicit upgrade runs the detected command and reports success
    it('runs the detected upgrade command and exits 0', async () => {
        let ran: string | undefined;
        const deps = npmDeps({ exec: async (cmd) => ((ran = cmd), { code: 0 }) });

        const { code, stdout } = await run(deps);
        assert.equal(code, 0);
        assert.match(ran ?? '', /npm install -g ultracontext/);

        const out = JSON.parse(stdout.trim());
        assert.equal(out.manager, 'npm');
        assert.equal(out.ran, true);
    });

    // a non-zero exec exit surfaces as a non-zero upgrade exit
    it('exits non-zero when the upgrade command fails', async () => {
        const deps = npmDeps({ exec: async () => ({ code: 1, error: 'boom' }) });
        const { code } = await run(deps);
        assert.notEqual(code, 0);
    });

    // --dry-run prints the command without executing it
    it('does not exec under --dry-run', async () => {
        let ran = false;
        const deps = npmDeps({ exec: async () => ((ran = true), { code: 0 }) });

        let out = '';
        const io = { stdout: { write: (s: string) => ((out += s), true) }, stderr: { write: () => true }, isTTY: false };
        const code = await runUpgrade({ json: true, dryRun: true }, deps, { io });

        assert.equal(code, 0);
        assert.equal(ran, false, 'exec not called under --dry-run');

        const parsed = JSON.parse(out.trim());
        assert.equal(parsed.ran, false);
        assert.match(parsed.command, /npm install -g ultracontext/);
    });
});
