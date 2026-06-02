// =============================================================================
// sync — `uc sync <init|start|stop|status|source|event>`. Thin Commander shell
// over @ultracontext/sync's fs-first Mutagen orchestration. Pipe-aware: data →
// stdout (JSON in machine mode), status/errors → stderr. Actions take injected
// SyncDeps + io so they're testable against a fake mutagen + temp config dir.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import {
    syncStart,
    syncStop,
    syncStatus,
    syncList,
    sourceAdd,
    sourceList,
    parseRemoteSpec,
    saveConfig,
    defaultHostId,
    type SyncDeps,
    type Config,
} from '@ultracontext/sync';
import { hostname } from 'node:os';

import { emit, status, outputError } from '../../../lib/output';

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
        return outputError(error, { ...deps.io, json: opts.json });
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
        return outputError(error, { ...deps.io, json: opts.json });
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
        return outputError(error, { ...deps.io, json: opts.json });
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
        return outputError(error, { ...deps.io, json: opts.json });
    }
}

// -- init ---------------------------------------------------------------------

// `uc sync init <local|user@host>` → write a fresh config (sources start empty)
export async function syncInitAction(
    opts: JsonOpt & { remote?: string; hostId?: string },
    deps: ActionDeps = {},
): Promise<number> {
    try {
        // the workspace target is required (interactive wizard lives in `uc init`)
        if (!opts.remote) throw new Error('usage: uc sync init <local|user@host>');

        // parse the target + derive a host id, persist the config
        const spec = parseRemoteSpec(opts.remote);
        const config: Config = {
            remote: spec.target,
            remoteRoot: spec.root,
            hostId: opts.hostId ?? defaultHostId(hostname()),
            sources: [],
        };
        await saveConfig(config, deps.sync?.configDir);

        emit({ data: config }, { json: opts.json, human: () => `initialized sync → ${config.remote}` }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: opts.json });
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
        return outputError(error, { ...deps.io, json: opts.json });
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
        return outputError(error, { ...deps.io, json: opts.json });
    }
}

// -- event (stub) -------------------------------------------------------------

// `uc sync event` → not yet ported (the 2.0 event log is out of this scope)
export async function syncEventAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    emit({ command: 'sync event', status: 'not_implemented' }, { json: opts.json, human: () => 'sync event: not implemented' }, deps.io);
    return 0;
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

    // init — write a fresh config from a workspace target
    sync
        .command('init')
        .description('initialize sync for a workspace target')
        .argument('[target]', 'local | user@host[:root]')
        .option('--host-id <id>', 'override the derived host id')
        .action((target, _opts, cmd) =>
            bridge((json) => syncInitAction({ json, remote: target, hostId: (cmd.opts() as { hostId?: string }).hostId }))(cmd),
        );

    // start / stop — bring enabled sources up / pause them
    sync.command('start').description('start sync for enabled sources').action((_opts, cmd) => bridge((json) => syncStartAction({ json }))(cmd));
    sync.command('stop').description('pause sync for enabled sources').action((_opts, cmd) => bridge((json) => syncStopAction({ json }))(cmd));

    // status / list — read live sessions / configured sources
    sync.command('status').description('show live sync session status').action((_opts, cmd) => bridge((json) => syncStatusAction({ json }))(cmd));
    sync.command('list').description('list configured sources with sync state').action((_opts, cmd) => bridge((json) => syncListAction({ json }))(cmd));

    // source — nested list/add group
    const source = sync.command('source').description('manage synced sources');
    source.command('list').description('list configured sources').action((_opts, cmd) => bridge((json) => syncSourceListAction({ json }))(cmd));
    source
        .command('add')
        .description('add or update a synced source')
        .argument('<name>', 'source name (letters, numbers, hyphens, underscores)')
        .argument('<path>', 'local path to sync')
        .option('--disabled', 'add the source without starting sync')
        .action((name, path, opts, cmd) => bridge((json) => syncSourceAddAction(name, path, { json, disabled: opts.disabled }))(cmd));

    // event — minimal stub (2.0 event log not ported here)
    sync.command('event').description('emit/commit context events (not implemented)').action((_opts, cmd) => bridge((json) => syncEventAction({ json }))(cmd));

    return sync as unknown as Command;
}
