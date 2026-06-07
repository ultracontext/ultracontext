// =============================================================================
// mirror — `uc mirror <start|stop|status|list|reset|source>`.
// Thin Commander shell over @ultracontext/mirror's fs-first Mutagen orchestration:
// a one-way fs replica of local sources to the remote. The remote target is
// configured by `uc remote set` (mirror only READS it). Pipe-aware: data → stdout
// (JSON in machine mode), status/errors → stderr. Actions take injected MirrorDeps
// + io so they're testable against a fake mutagen + temp config dir.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import {
    mirrorStart,
    mirrorStop,
    mirrorStatus,
    mirrorList,
    mirrorReset,
    sourceAdd,
    sourceList,
    sourceRemove,
    sourceSetEnabled,
    type MirrorDeps,
} from '@ultracontext/mirror';

import { emit, status, outputError, shouldJson } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io + tty overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps every action reads: the orchestration seam + io + the --json toggle
type ActionDeps = { sync?: MirrorDeps; io?: Io };

// -- options ------------------------------------------------------------------

// the global --json flag flows in from the program root
type JsonOpt = { json?: boolean };

// -- status -------------------------------------------------------------------

// `uc mirror status` → emit the parsed live sessions
export async function mirrorStatusAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        const sessions = await mirrorStatus(deps.sync);
        emit({ data: sessions }, { json: opts.json, human: () => humanStatus(sessions) }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// render the session list as terse human lines
function humanStatus(sessions: Awaited<ReturnType<typeof mirrorStatus>>): string {
    if (sessions.length === 0) return 'no mirror sessions — run `uc mirror start`';
    return sessions.map((s) => `${s.name}  ${s.status}`).join('\n');
}

// -- list ---------------------------------------------------------------------

// `uc mirror list` → emit each configured source crossed with its mirror state
export async function mirrorListAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        const entries = await mirrorList(deps.sync);
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

// `uc mirror start` → start/resume every enabled source
export async function mirrorStartAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('starting mirror…', deps.io);
        await mirrorStart(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'mirror started' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- stop ---------------------------------------------------------------------

// `uc mirror stop` → pause every enabled source
export async function mirrorStopAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('pausing mirror…', deps.io);
        await mirrorStop(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'mirror paused' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- reset --------------------------------------------------------------------

// `uc mirror reset` → terminate every owned session, then restart enabled sources
export async function mirrorResetAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
    try {
        if (!opts.json) status('resetting mirror…', deps.io);
        await mirrorReset(deps.sync);
        emit({ ok: true }, { json: opts.json, human: () => 'mirror reset' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- source list / add --------------------------------------------------------

// `uc mirror source list` → emit the configured sources
export async function mirrorSourceListAction(opts: JsonOpt, deps: ActionDeps = {}): Promise<number> {
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

// `uc mirror source add <name> <path> [--disabled]` → add + start the source
export async function mirrorSourceAddAction(
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

// `uc mirror source remove <name> [--purge-remote]` → terminate session + drop source
export async function mirrorSourceRemoveAction(
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

// `uc mirror source enable|disable <name>` → flip the enabled flag + apply session
export async function mirrorSourceSetEnabledAction(
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

// build the `mirror` Commander group with every subcommand wired
export function buildMirrorCommand(): Command {
    const mirror = new Command('mirror')
        .description('one-way fs replica of local sources to the remote (Mutagen)');

    // start / stop — bring enabled sources up / pause them
    mirror.command('start').description('start the mirror for enabled sources').action((_opts, cmd) => bridge((json) => mirrorStartAction({ json }))(cmd));
    mirror.command('stop').description('pause the mirror for enabled sources').action((_opts, cmd) => bridge((json) => mirrorStopAction({ json }))(cmd));

    // status / list — read live sessions / configured sources
    mirror.command('status').description('show live mirror session status').action((_opts, cmd) => bridge((json) => mirrorStatusAction({ json }))(cmd));
    mirror.command('list').description('list configured sources with mirror state').action((_opts, cmd) => bridge((json) => mirrorListAction({ json }))(cmd));

    // reset — terminate owned sessions, then restart enabled sources fresh
    mirror.command('reset').description('terminate owned sessions and restart enabled sources').action((_opts, cmd) => bridge((json) => mirrorResetAction({ json }))(cmd));

    // source — nested list/add/remove/enable/disable group
    const source = mirror.command('source').description('manage mirrored sources');
    source.command('list').description('list configured sources').action((_opts, cmd) => bridge((json) => mirrorSourceListAction({ json }))(cmd));
    source
        .command('add')
        .description('add or update a mirrored source')
        .argument('<name>', 'source name (letters, numbers, hyphens, underscores)')
        .argument('<path>', 'local path to mirror')
        .option('--disabled', 'add the source without starting the mirror')
        .action((name, path, opts, cmd) => bridge((json) => mirrorSourceAddAction(name, path, { json, disabled: opts.disabled }))(cmd));

    // remove — drop a source; --purge-remote also deletes its remote copy (destructive)
    source
        .command('remove')
        .description('remove a mirrored source')
        .argument('<name>', 'source name')
        .option('--purge-remote', 'DESTRUCTIVE: also delete the source\'s remote workspace dir')
        .action((name, opts, cmd) => bridge((json) => mirrorSourceRemoveAction(name, { json, purgeRemote: opts.purgeRemote }))(cmd));

    // enable / disable — flip a source's enabled flag + apply the session change
    source
        .command('enable')
        .description('enable a mirrored source')
        .argument('<name>', 'source name')
        .action((name, _opts, cmd) => bridge((json) => mirrorSourceSetEnabledAction(name, true, { json }))(cmd));
    source
        .command('disable')
        .description('disable a mirrored source')
        .argument('<name>', 'source name')
        .action((name, _opts, cmd) => bridge((json) => mirrorSourceSetEnabledAction(name, false, { json }))(cmd));

    return mirror as unknown as Command;
}
