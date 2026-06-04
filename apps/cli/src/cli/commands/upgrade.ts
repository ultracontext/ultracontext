// =============================================================================
// update — `uc update`. Self-update the CLI (the context-edit verb lives at
// `uc context update`). Detect the install method from
// the resolved binary path (npm / brew / curl) and run the matching upgrade
// command. The proactive update *notice* is suppressed in CI / pipes / --json
// so it never pollutes machine output; the explicit invocation always runs.
// Path + env + exec are injected so detection + suppression are testable with
// no real subprocess.
// =============================================================================

import { Command } from '@commander-js/extra-typings';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { emit, outputError } from '../../../lib/output';
import { VERSION } from '../../../lib/version';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Runtime = { io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean } };

// -- install method -----------------------------------------------------------

// a detected install + the shell command that upgrades it in place
type InstallMethod = { manager: 'npm' | 'brew' | 'curl'; command: string };

// the curl one-liner that re-installs the standalone build
const CURL_INSTALL = 'curl -fsSL https://ultracontext.ai/install.sh | sh';

// map the resolved binary path to the manager that owns it
export function detectInstallMethod(binPath: string): InstallMethod {
    // homebrew keeps binaries under a Cellar (or linuxbrew) prefix
    if (/\/(Cellar|homebrew|linuxbrew)\//.test(binPath)) {
        return { manager: 'brew', command: 'brew upgrade ultracontext' };
    }

    // a global npm install lives under node_modules
    if (binPath.includes('node_modules')) {
        return { manager: 'npm', command: 'npm install -g ultracontext@latest' };
    }

    // otherwise assume the curl-installed standalone build
    return { manager: 'curl', command: CURL_INSTALL };
}

// -- notice suppression -------------------------------------------------------

// the proactive notice is suppressed in CI, machine mode, or a piped stdout
export function shouldSuppressNotice(ctx: { json: boolean; isTTY: boolean; env: Record<string, string | undefined> }): boolean {
    if (ctx.env.CI) return true;
    if (ctx.json) return true;
    if (!ctx.isTTY) return true;
    return false;
}

// -- deps ---------------------------------------------------------------------

// the seam every upgrade interaction flows through (path / version / env / exec)
export type UpgradeDeps = {
    binPath: string;
    version: string;
    env: Record<string, string | undefined>;
    exec: (command: string) => Promise<{ code: number; error?: string }>;
};

// -- handler ------------------------------------------------------------------

// detect the method, run (or, under --dry-run, just print) the upgrade command
export async function runUpgrade(
    opts: { json?: boolean; dryRun?: boolean },
    deps: UpgradeDeps,
    runtime: Runtime = {},
): Promise<number> {
    const io = runtime.io;
    const method = detectInstallMethod(deps.binPath);

    try {
        // --dry-run reports the command it would run without touching the system
        if (opts.dryRun) {
            emit(
                { manager: method.manager, command: method.command, ran: false, version: deps.version },
                { json: opts.json, human: (d) => `would run: ${(d as { command: string }).command}` },
                io,
            );
            return 0;
        }

        // run the upgrade; a non-zero exit becomes a thrown failure
        const result = await deps.exec(method.command);
        if (result.code !== 0) throw new Error(result.error ?? `upgrade command failed (${method.command})`);

        // report the run + the command that executed
        emit(
            { manager: method.manager, command: method.command, ran: true, version: deps.version },
            { json: opts.json, human: () => `upgraded via ${method.manager}` },
            io,
        );
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- real exec ----------------------------------------------------------------

// run a shell command, streaming its output to the parent's stdio
function shellExec(command: string): Promise<{ code: number; error?: string }> {
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', command], { stdio: 'inherit' });
        child.on('error', (err) => resolve({ code: 1, error: err.message }));
        child.on('close', (code) => resolve({ code: code ?? 0 }));
    });
}

// the resolved path of the running binary (so detection sees the real install)
function resolveBinPath(): string {
    try { return fileURLToPath(import.meta.url); } catch { return process.argv[1] ?? ''; }
}

// -- command factory ----------------------------------------------------------

// build the `upgrade` verb, wiring the real path + exec behind the seam
export function buildUpgradeCommand(): Command {
    const command = new Command('update');

    // self-update the uc CLI
    command
        .description('self-update the uc CLI')
        .option('--dry-run', 'print the upgrade command without running it')
        .action(async (opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);

            // assemble the live deps: resolved bin path + env + a real shell exec
            const deps: UpgradeDeps = {
                binPath: resolveBinPath(),
                version: VERSION,
                env: process.env,
                exec: shellExec,
            };

            process.exitCode = await runUpgrade({ json, dryRun: opts.dryRun }, deps);
        });

    return command;
}
