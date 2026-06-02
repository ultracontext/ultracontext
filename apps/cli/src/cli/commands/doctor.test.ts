// =============================================================================
// doctor.test — RED. `uc doctor` reports environment health: uc version, the
// ~/.ultracontext dir, local db reachability, mutagen availability, remote
// reachability (only if configured), and the credential source. Every probe is
// injected so the checks run with no real fs / db / network / subprocess.
// Hard-check failures (config dir, local db) drive a non-zero exit; soft checks
// (mutagen, remote) only warn.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runDoctor, type DoctorDeps } from './doctor';

// -- harness ------------------------------------------------------------------

// a captured run: stdout/stderr text + the returned exit code
type RunResult = { stdout: string; stderr: string; code: number };

// a fully-healthy deps set; individual tests override one probe at a time
function healthyDeps(): DoctorDeps {
    return {
        version: '1.5.0',
        // config dir + local db both reachable (hard checks)
        configDirExists: async () => true,
        probeDb: async () => ({ ok: true }),
        // mutagen present, no remote configured (soft checks)
        probeMutagen: async () => ({ ok: true, version: 'mutagen 0.18' }),
        clientConfig: {},
        env: {},
        probeRemote: async () => ({ ok: true }),
    };
}

// run doctor with captured io + the given (possibly overridden) deps
async function run(deps: DoctorDeps, json = true): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    const io = {
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
        isTTY: !json,
    };

    const code = await runDoctor({ json }, deps, { io });
    return { stdout, stderr, code };
}

// parse the single JSON line doctor emits in machine mode
function parse(stdout: string): { ok: boolean; checks: { name: string; ok: boolean; hard: boolean; detail?: string }[] } {
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one JSON line');
    return JSON.parse(lines[0]);
}

// -- all healthy --------------------------------------------------------------

describe('uc doctor', () => {
    // a healthy environment passes every check and exits 0
    it('reports ok and exits 0 when everything passes', async () => {
        const { code, stdout } = await run(healthyDeps());
        assert.equal(code, 0);

        const out = parse(stdout);
        assert.equal(out.ok, true);
        for (const name of ['version', 'config-dir', 'local-db', 'mutagen', 'credentials']) {
            assert.ok(out.checks.some((c) => c.name === name), `missing check: ${name}`);
        }
    });

    // -- hard failure: local db unreachable -----------------------------------

    // a failed hard check (local db) flips ok=false and exits 1
    it('exits 1 when a hard check fails', async () => {
        const deps = healthyDeps();
        deps.probeDb = async () => ({ ok: false, error: 'cannot open db' });

        const { code, stdout } = await run(deps);
        assert.equal(code, 1);

        const out = parse(stdout);
        assert.equal(out.ok, false);
        const db = out.checks.find((c) => c.name === 'local-db');
        assert.equal(db!.ok, false);
        assert.equal(db!.hard, true);
    });

    // -- soft failure: mutagen missing ----------------------------------------

    // a missing mutagen is a soft check — it warns but never fails the run
    it('still exits 0 when only a soft check fails', async () => {
        const deps = healthyDeps();
        deps.probeMutagen = async () => ({ ok: false, error: 'mutagen not found' });

        const { code, stdout } = await run(deps);
        assert.equal(code, 0);

        const out = parse(stdout);
        assert.equal(out.ok, true);
        const mut = out.checks.find((c) => c.name === 'mutagen');
        assert.equal(mut!.ok, false);
        assert.equal(mut!.hard, false);
    });

    // -- remote check only when configured ------------------------------------

    // with no credentials, the remote check is skipped entirely
    it('omits the remote check when no credentials are configured', async () => {
        const { stdout } = await run(healthyDeps());
        const out = parse(stdout);
        assert.ok(!out.checks.some((c) => c.name === 'remote'), 'remote not probed when unconfigured');
    });

    // with credentials present, the remote reachability check runs + is soft
    it('runs the remote check when credentials are configured', async () => {
        const deps = healthyDeps();
        deps.clientConfig = { baseUrl: 'https://api.example.com', apiKey: 'sk-test' };

        const { stdout } = await run(deps);
        const out = parse(stdout);
        const remote = out.checks.find((c) => c.name === 'remote');
        assert.ok(remote, 'remote check present');
        assert.equal(remote!.hard, false);
    });

    // -- credential source detection ------------------------------------------

    // the credentials check names env as the source when UC_API_KEY is set
    it('reports env as the credential source', async () => {
        const deps = healthyDeps();
        deps.env = { UC_API_KEY: 'sk-env' };

        const { stdout } = await run(deps);
        const out = parse(stdout);
        const cred = out.checks.find((c) => c.name === 'credentials');
        assert.match(cred!.detail ?? '', /env/);
    });

    // with config creds and no env, the source is the config file
    it('reports config as the credential source', async () => {
        const deps = healthyDeps();
        deps.clientConfig = { apiKey: 'sk-cfg' };
        deps.env = {};

        const { stdout } = await run(deps);
        const out = parse(stdout);
        const cred = out.checks.find((c) => c.name === 'credentials');
        assert.match(cred!.detail ?? '', /config/);
    });

    // with neither, the source is local-only (no remote credentials)
    it('reports local-only when no credentials exist', async () => {
        const { stdout } = await run(healthyDeps());
        const out = parse(stdout);
        const cred = out.checks.find((c) => c.name === 'credentials');
        assert.match(cred!.detail ?? '', /local/);
    });
});
