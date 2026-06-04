// =============================================================================
// sync — `uc sync <start|stop|status|list|reset|source>`. Thin Commander shell
// over @ultracontext/sync's fs-first Mutagen orchestration. The remote target is
// configured by `uc remote set` (sync only READS it). Pipe-aware: data → stdout
// (JSON in machine mode), status/errors → stderr. Actions take injected SyncDeps
// + io so they're testable against a fake mutagen + temp config dir.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import {
    syncStart,
    syncStop,
    syncStatus,
    syncList,
    syncReset,
    sourceAdd,
    sourceList,
    sourceRemove,
    sourceSetEnabled,
    type SyncDeps,
} from '@ultracontext/sync';

import { emit, status, outputError, shouldJson } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io + tty overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps every action reads: the orchestration seam + io + the --json toggle
type ActionDeps = { sync?: SyncDeps; io?: Io };

// -- options ------------------------------------------------------------------

// the global --json flag flows in from the program root
type JsonOpt = { json?: boolean };

// -- status -------------------------------------------------------------------

// `uc sync status` → emit the parsed live sessions
export async function syncStatusAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        const sessions = await syncStatus(deps.sync);
        emit({ data: sessions }, { json: opts.json, human: () => humanStatus(sessions) }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// render the session list as terse human lines
function humanStatus(sessions: Awaited<ReturnType<typeof syncStatus>>): string {
    if (sessions.length === 0) return 'no sync sessions — run `uc sync start`';
    return sessions.map((s) => `${s.name}  ${s.status}`).join('\n');
}

// -- list ---------------------------------------------------------------------

// `uc sync list` → emit each configured source crossed with its sync state
export async function syncListAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        const entries = await syncList(deps.sync);
        emit(
            { data: entries },
            { json: opts.json, human: () => entries.map((e) => `${e.source}  ${e.syncState}  ${e.sourceState}`).join('\n') },
            deps.io,
        );
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- start --------------------------------------------------------------------

// `uc sync start` → start/resume every enabled source
export async function syncStartAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('starting sync…', deps.io);
        await syncStart(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'sync started' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- stop ---------------------------------------------------------------------

// `uc sync stop` → pause every enabled source
export async function syncStopAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('pausing sync…', deps.io);
        await syncStop(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'sync paused' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- reset --------------------------------------------------------------------

// `uc sync reset` → terminate every owned session, then restart enabled sources
export async function syncResetAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('resetting sync…', deps.io);
        await syncReset(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'sync reset' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- source list / add --------------------------------------------------------

// `uc sync source list` → emit the configured sources
export async function syncSourceListAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        const sources = await sourceList(deps.sync);
        emit(
            { data: sources },
            { json: opts.json, human: () => sources.map((s) => `${s.agent}  ${s.enabled ? 'enabled' : 'disabled'}  ${s.localPath}`).join('\n') },
            deps.io,
        );
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// `uc sync source add <name> <path> [--disabled]` → add + start the source
export async function syncSourceAddAction(
    name: string,
    path: string,
    opts: JsonOpt & { disabled?: boolean },
    deps: ActionDeps = {},
): Promise<number> {
    try {
        const enabled = !opts.disabled;
        const { existed } = await sourceAdd(name, path, enabled, deps.sync);
        emit({ ok: true, existed }, { json: opts.json, human: () => `source ${name}: ${existed ? 'updated' : 'added'}` }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// `uc sync source remove <name> [--purge-remote]` → terminate session + drop source
export async function syncSourceRemoveAction(
    name: string,
    opts: JsonOpt & { purgeRemote?: boolean },
    deps: ActionDeps = {},
): Promise<number> {
    try {
        const purgedRemote = Boolean(opts.purgeRemote);
        await sourceRemove(name, { purgeRemote: purgedRemote }, deps.sync);
        emit(
            { removed: true, name, purgedRemote },
            { json: opts.json, human: () => `removed ${name}` },
            deps.io,
        );
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// `uc sync source enable|disable <name>` → flip the enabled flag + apply session
export async function syncSourceSetEnabledAction(
    name: string,
    enabled: boolean,
    opts: JsonOpt,
    deps: ActionDeps = {},
): Promise<number> {
    try {
        await sourceSetEnabled(name, enabled, deps.sync);
        emit(
            { name, enabled },
            { json: opts.json, human: () => `source ${name}: ${enabled ? 'enabled' : 'disabled'}` },
            deps.io,
        );
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- commander bridge ---------------------------------------------------------

// the minimal Command surface the bridge reads (any subcommand arg/opt shape)
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

// build the `sync` Commander group with every subcommand wired to its action
export function buildSyncCommand(): Command {
    const sync = new Command('sync').description('fs-first sync orchestration');

    // start / stop — bring enabled sources up / pause them
    sync.command('start').description('start sync for enabled sources').action((_opts, cmd) => bridge((json) => syncStartAction({ json }))(cmd));
    sync.command('stop').description('pause sync for enabled sources').action((_opts, cmd) => bridge((json) => syncStopAction({ json }))(cmd));

    // status / list — read live sessions / configured sources
    sync.command('status').description('show live sync session status').action((_opts, cmd) => bridge((json) => syncStatusAction({ json }))(cmd));
    sync.command('list').description('list configured sources with sync state').action((_opts, cmd) => bridge((json) => syncListAction({ json }))(cmd));

    // reset — terminate owned sessions, then restart enabled sources fresh
    sync.command('reset').description('terminate owned sessions and restart enabled sources').action((_opts, cmd) => bridge((json) => syncResetAction({ json }))(cmd));

    // source — nested list/add/remove/enable/disable group
    const source = sync.command('source').description('manage synced sources');
    source.command('list').description('list configured sources').action((_opts, cmd) => bridge((json) => syncSourceListAction({ json }))(cmd));
    source
        .command('add')
        .description('add or update a synced source')
        .argument('<name>', 'source name (letters, numbers, hyphens, underscores)')
        .argument('<path>', 'local path to sync')
        .option('--disabled', 'add the source without starting sync')
        .action((name, path, opts, cmd) => bridge((json) => syncSourceAddAction(name, path, { json, disabled: opts.disabled }))(cmd));

    // remove — drop a source; --purge-remote also deletes its remote copy (destructive)
    source
        .command('remove')
        .description('remove a synced source')
        .argument('<name>', 'source name')
        .option('--purge-remote', 'DESTRUCTIVE: also delete the source\'s remote workspace dir')
        .action((name, opts, cmd) => bridge((json) => syncSourceRemoveAction(name, { json, purgeRemote: opts.purgeRemote }))(cmd));

    // enable / disable — flip a source's enabled flag + apply the session change
    source
        .command('enable')
        .description('enable a synced source')
        .argument('<name>', 'source name')
        .action((name, _opts, cmd) => bridge((json) => syncSourceSetEnabledAction(name, true, { json }))(cmd));
    source
        .command('disable')
        .description('disable a synced source')
        .argument('<name>', 'source name')
        .action((name, _opts, cmd) => bridge((json) => syncSourceSetEnabledAction(name, false, { json }))(cmd));

    return sync as unknown as Command;
}
