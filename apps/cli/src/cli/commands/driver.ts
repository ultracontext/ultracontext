// =============================================================================
// driver — the TOP-LEVEL `uc driver <list|run>` family (never under `uc mirror`).
// Maps the documented driver surface (apps/docs/concepts/drivers.mdx) onto the
// manifest reader + the sh-c runner. `list` shows installed manifests; `run`
// executes a manifest command as a local process on this host, streaming its
// stdio through and propagating the exit code. Pipe-aware: data → stdout,
// status/errors → stderr. Manifests never hold secrets — error paths name the
// driver/command/path, never the manifest body.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { configDir as defaultConfigDir } from '@ultracontext/sync';

import { listDrivers, loadDriver, driversDir, type DriverListing } from '../../../lib/drivers/manifest';
import { runDriver, type Spawn } from '../../../lib/drivers/run';
import { emit, status, outputError } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps every action reads: the configDir (drivers/ live under it) + an
// injectable spawn (run only) + io. Defaults resolve the real ~/.ultracontext.
export type DriverDeps = { configDir?: string; spawn?: Spawn; io?: Io };

// the global --json flag flows in from the program root
type JsonOpt = { json?: boolean };

// -- list ---------------------------------------------------------------------

// `uc driver list` → installed manifests. Human: one line per driver
// (name@version + its command names), a per-driver error appended inline; an
// empty install reports the path on stderr. --json: the manifest array on stdout.
export async function listAction(opts: JsonOpt, deps: DriverDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        const configDir = deps.configDir ?? defaultConfigDir();
        const drivers = await listDrivers({ configDir });

        // empty install → a clear stderr hint (human mode), still exit 0
        if (drivers.length === 0) status(`no drivers installed in ${driversDir(configDir)}`, io);

        // data → stdout: the manifest array under --json, one line each otherwise
        emit(drivers, { json: opts.json, human: () => drivers.map(humanLine).join('\n') }, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// render one driver as `name@version  cmd1, cmd2` (or its per-driver error)
function humanLine(d: DriverListing): string {
    if (d.error) return `${d.name}\t(error: ${d.error})`;
    const commands = Object.keys(d.commands).sort().join(', ') || '(no commands)';
    return `${d.name}@${d.version ?? '0.0.0'}\t${commands}`;
}

// -- run ----------------------------------------------------------------------

// `uc driver run <driver> <command>` → load the manifest, resolve the command,
// execute it via sh -c with inherited stdio (stream-through), and exit with the
// child's code. A missing driver / command fails clearly (exit 1).
export async function runAction(driver: string, command: string, opts: JsonOpt, deps: DriverDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        // resolve the manifest (clear not-found error for a missing driver)
        const manifest = await loadDriver(driver, { configDir: deps.configDir ?? defaultConfigDir() });

        // execute the verb; the child's exit code becomes ours
        return await runDriver(manifest, command, { spawn: deps.spawn });
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- commander bridge ---------------------------------------------------------

// the minimal Command surface the bridge reads
type AnyCommand = { optsWithGlobals(): unknown };

// read the global --json flag off any command in the tree
function jsonFlag(cmd: AnyCommand): boolean {
    return Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
}

// run an action with live process io, exiting non-zero on its returned code
function bridge(run: (json: boolean) => Promise<number>) {
    return async (cmd: AnyCommand) => {
        const code = await run(jsonFlag(cmd));
        if (code !== 0) process.exit(code);
    };
}

// -- command factory ----------------------------------------------------------

// build the top-level `driver` Commander group with list + run wired
export function buildDriverCommand(): Command {
    const driver = new Command('driver').description('list and run installed driver manifests');

    // list — show installed manifests from ~/.ultracontext/drivers/
    driver
        .command('list')
        .description('list installed driver manifests')
        .action((_opts, cmd) => bridge((json) => listAction({ json }))(cmd));

    // run — execute a manifest command as a local process (exit = child's)
    driver
        .command('run')
        .description('run a manifest command as a local process on this host')
        .argument('<driver>', 'installed driver name')
        .argument('<command>', 'manifest command verb (e.g. opened, poll, status)')
        .action((driverName, command, _opts, cmd) => bridge((json) => runAction(driverName, command, { json }))(cmd));

    return driver as unknown as Command;
}
