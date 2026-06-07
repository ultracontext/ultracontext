// =============================================================================
// doctor — `uc doctor`. Probe the local environment and report a health card:
// uc version, ~/.ultracontext presence, local db reachability, mutagen
// availability, remote reachability (only when configured), and the credential
// source. Hard checks (config dir, local db) drive a non-zero exit; soft checks
// (mutagen, remote) only warn. Every probe is injected so the logic is testable
// with no real fs / db / network / subprocess.
// =============================================================================

import { Command } from '@commander-js/extra-typings';
import { stat } from 'node:fs/promises';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';
import { spawnRunner } from '@ultracontext/sync';

import { emit } from '../../../lib/output';
import { configDir, dbUrl as defaultDbUrl } from '../../../lib/config';
import { loadClientConfig } from '../../../lib/client-config';
import type { ClientConfig } from '../../../lib/resolve-client';
import { VERSION } from '../../../lib/version';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Runtime = { io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean } };

// -- probe results ------------------------------------------------------------

// a probe either succeeds (optionally with a version) or fails with an error
type Probe = { ok: boolean; error?: string };
type VersionProbe = Probe & { version?: string };

// -- deps ---------------------------------------------------------------------

// every external interaction doctor performs, injected so checks stay pure
export type DoctorDeps = {
    version: string;
    configDirExists: () => Promise<boolean>;
    probeDb: () => Promise<Probe>;
    probeMutagen: () => Promise<VersionProbe>;
    clientConfig: ClientConfig;
    env: Record<string, string | undefined>;
    probeRemote: () => Promise<Probe>;
};

// -- check shape --------------------------------------------------------------

// one rendered check: a name, pass/fail, hard/soft weight, and a human detail
type Check = { name: string; ok: boolean; hard: boolean; detail?: string };

// the full report: an overall ok plus every check
type Report = { ok: boolean; checks: Check[] };

// -- credential source --------------------------------------------------------

// name where remote credentials come from: env, the config file, or local-only
function credentialSource(deps: DoctorDeps): string {
    if (deps.env.UC_API_KEY) return 'env (UC_API_KEY)';
    if (deps.clientConfig.apiKey) return 'config (~/.ultracontext/config.json)';
    return 'local-only (no remote credentials)';
}

// remote is configured when either env or config carries a base url + key
function remoteConfigured(deps: DoctorDeps): boolean {
    const url = deps.env.UC_API_URL ?? deps.clientConfig.baseUrl;
    const key = deps.env.UC_API_KEY ?? deps.clientConfig.apiKey;
    return Boolean(url && key);
}

// -- checks -------------------------------------------------------------------

// run every probe and assemble the ordered check list (remote only if configured)
async function runChecks(deps: DoctorDeps): Promise<Check[]> {
    const checks: Check[] = [];

    // version — always passes; informational
    checks.push({ name: 'version', ok: true, hard: false, detail: `uc ${deps.version}` });

    // config dir — hard: ~/.ultracontext must exist (uc init creates it)
    const dir = await deps.configDirExists();
    checks.push({ name: 'config-dir', ok: dir, hard: true, detail: dir ? 'present' : 'missing — run `uc init`' });

    // local db — hard: the sqlite store must open
    const db = await deps.probeDb();
    checks.push({ name: 'local-db', ok: db.ok, hard: true, detail: db.ok ? 'reachable' : (db.error ?? 'unreachable') });

    // mutagen — soft: only needed for `uc mirror`
    const mut = await deps.probeMutagen();
    checks.push({ name: 'mutagen', ok: mut.ok, hard: false, detail: mut.ok ? (mut.version ?? 'available') : (mut.error ?? 'not found') });

    // remote — soft, and only when credentials are configured
    if (remoteConfigured(deps)) {
        const remote = await deps.probeRemote();
        checks.push({ name: 'remote', ok: remote.ok, hard: false, detail: remote.ok ? 'reachable' : (remote.error ?? 'unreachable') });
    }

    // credentials — always passes; reports the resolved source
    checks.push({ name: 'credentials', ok: true, hard: false, detail: credentialSource(deps) });

    return checks;
}

// -- report -------------------------------------------------------------------

// build the report; ok is false only when a hard check fails
async function buildReport(deps: DoctorDeps): Promise<Report> {
    const checks = await runChecks(deps);
    const ok = checks.every((c) => c.ok || !c.hard);
    return { ok, checks };
}

// -- human render -------------------------------------------------------------

// render the report as terse lines (one per check) with a header status
function humanReport(report: Report): string {
    const lines = report.checks.map((c) => {
        const mark = c.ok ? 'ok ' : c.hard ? 'FAIL' : 'warn';
        return `[${mark}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`;
    });
    return [report.ok ? 'doctor: healthy' : 'doctor: problems found', ...lines].join('\n');
}

// -- handler ------------------------------------------------------------------

// run the probes, emit the report, and return 0 (healthy) or 1 (hard failure)
export async function runDoctor(opts: { json?: boolean }, deps: DoctorDeps, runtime: Runtime = {}): Promise<number> {
    const report = await buildReport(deps);

    // the report is data → stdout; JSON in machine mode, lines otherwise
    emit(report, { json: opts.json, human: (d) => humanReport(d as Report) }, runtime.io);
    return report.ok ? 0 : 1;
}

// -- real probes --------------------------------------------------------------

// does ~/.ultracontext exist?
async function probeConfigDir(): Promise<boolean> {
    try { return (await stat(configDir())).isDirectory(); } catch { return false; }
}

// can we open the local sqlite store?
async function probeLocalDb(): Promise<Probe> {
    try {
        await createSqliteAdapter(defaultDbUrl());
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// is the mutagen binary on PATH? (report its version line when present)
async function probeMutagen(): Promise<VersionProbe> {
    try {
        const result = await spawnRunner('mutagen', ['version']);
        if (result.code !== 0) return { ok: false, error: 'mutagen not found' };
        return { ok: true, version: ('mutagen ' + result.stdout.trim()).trim() };
    } catch {
        return { ok: false, error: 'mutagen not found' };
    }
}

// is the configured hosted API reachable? (a GET against its base url)
function probeRemote(config: ClientConfig, env: Record<string, string | undefined>): () => Promise<Probe> {
    return async () => {
        const url = env.UC_API_URL ?? config.baseUrl;
        if (!url) return { ok: false, error: 'no base url' };
        try {
            const res = await fetch(url, { method: 'GET' });
            return res.ok || res.status === 401 ? { ok: true } : { ok: false, error: `status ${res.status}` };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };
}

// -- command factory ----------------------------------------------------------

// build the `doctor` verb, wiring the real probes behind the injectable seam
export function buildDoctorCommand(): Command {
    const command = new Command('doctor');

    // diagnose the local environment
    command
        .description('diagnose the local environment')
        .action(async (_opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);

            // assemble the live deps: env + persisted config + real probes
            const env = process.env;
            const clientConfig = await loadClientConfig();
            const deps: DoctorDeps = {
                version: VERSION,
                configDirExists: probeConfigDir,
                probeDb: probeLocalDb,
                probeMutagen,
                clientConfig,
                env,
                probeRemote: probeRemote(clientConfig, env),
            };

            process.exitCode = await runDoctor({ json }, deps);
        });

    return command;
}
