// =============================================================================
// sync — fs-first orchestration over the `mutagen` binary. start/stop/status/
// reset/list call mutagen through an injectable CommandRunner (so tests use a
// fake binary). Source add/list mutate the config + apply the matching session.
// =============================================================================

import { mkdir } from 'node:fs/promises';

import {
    loadConfig,
    saveConfig,
    enabledSources,
    isLocalConfig,
    mutagenSessionName,
    remoteEndpoint,
    expandHome,
    upsertSource,
    findSource,
    type Config,
    type Source,
} from './config';
import {
    parseMutagenSessions,
    mutagenSessionStatus,
    mutagenSessionExists,
    ownedMutagenSessionNames,
    spawnRunner,
    type CommandRunner,
    type SessionInfo,
} from './mutagen';

// -- injectable dependencies --------------------------------------------------

// the seams the orchestration touches — all faked in tests
export type SyncDeps = {
    configDir?: string;
    runCommand?: CommandRunner;
    commandExists?: (name: string) => Promise<boolean>;
    pathExists?: (path: string) => Promise<boolean>;
};

// fill SyncDeps with the real implementations (spawn + fs probes)
function resolveDeps(deps: SyncDeps = {}): Required<SyncDeps> {
    return {
        configDir: deps.configDir ?? undefined!,
        runCommand: deps.runCommand ?? spawnRunner,
        commandExists: deps.commandExists ?? realCommandExists,
        pathExists: deps.pathExists ?? realPathExists,
    };
}

// probe PATH for a binary via `command -v` (real default)
const realCommandExists: (name: string) => Promise<boolean> = async (name) => {
    const result = await spawnRunner('sh', ['-c', `command -v ${name} >/dev/null 2>&1`]);
    return result.code === 0;
};

// probe the filesystem for a path (real default)
const realPathExists: (path: string) => Promise<boolean> = async (path) => {
    const { access } = await import('node:fs/promises');
    try {
        await access(expandHome(path));
        return true;
    } catch {
        return false;
    }
};

// -- mutagen call helpers -----------------------------------------------------

// run a mutagen subcommand, throwing on a non-zero exit
async function mutagen(deps: Required<SyncDeps>, args: string[]): Promise<string> {
    const result = await deps.runCommand('mutagen', args);
    if (result.code !== 0) {
        throw new Error(`mutagen ${args.join(' ')} exited with ${result.code}\n${result.stderr.trim()}`);
    }
    return result.stdout;
}

// fetch the current `mutagen sync list` blob (short form)
function listSessions(deps: Required<SyncDeps>): Promise<string> {
    return mutagen(deps, ['sync', 'list']);
}

// guard: the mutagen binary must be installed before any orchestration
async function requireMutagen(deps: Required<SyncDeps>): Promise<void> {
    if (!(await deps.commandExists('mutagen'))) {
        throw new Error('required command not found: mutagen');
    }
}

// -- remote workspace prep ----------------------------------------------------

// ensure the per-host workspace dirs exist (local: mkdir; ssh: remote mkdir -p)
async function prepareRemoteWorkspace(deps: Required<SyncDeps>, config: Config): Promise<void> {
    // collect the workspace root, the host dir, and each enabled source dir
    const dirs = [
        `${config.remoteRoot}/workspace`,
        `${config.remoteRoot}/workspace/${config.hostId}`,
        ...enabledSources(config).map((source) => endpointDir(config, source)),
    ];

    // local workspace → just create the directories on this machine
    if (isLocalConfig(config)) {
        for (const dir of dirs) await mkdir(expandHome(dir), { recursive: true });
        return;
    }

    // remote workspace → one ssh `mkdir -p` for all dirs
    const result = await deps.runCommand('ssh', [config.remote, `mkdir -p ${dirs.join(' ')}`]);
    if (result.code !== 0) throw new Error(`ssh mkdir failed: ${result.stderr.trim()}`);
}

// the bare directory portion of a source's remote endpoint (no `target:` prefix)
function endpointDir(config: Config, source: Source): string {
    const endpoint = remoteEndpoint(config, source);
    return isLocalConfig(config) ? endpoint : endpoint.slice(config.remote.length + 1);
}

// -- start --------------------------------------------------------------------

// start (or resume) sync for every enabled source
export async function syncStart(rawDeps: SyncDeps = {}): Promise<void> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const config = await loadConfig(deps.configDir);
    const existing = await listSessions(deps);
    await prepareRemoteWorkspace(deps, config);

    // bring each enabled source online
    for (const source of enabledSources(config)) {
        await startSource(deps, config, source, existing);
    }
}

// create a fresh session, or resume+flush one that already exists
async function startSource(
    deps: Required<SyncDeps>,
    config: Config,
    source: Source,
    existing: string,
): Promise<void> {
    // skip sources whose local path is gone (nothing to sync from)
    if (!(await deps.pathExists(source.localPath))) return;

    const name = mutagenSessionName(config, source);

    // resume + flush when the session is already known to mutagen
    if (mutagenSessionExists(existing, name)) {
        await mutagen(deps, ['sync', 'resume', name]);
        await mutagen(deps, ['sync', 'flush', name]);
        return;
    }

    // otherwise create a one-way replica from the local path to the remote
    const args = createArgs(name, expandHome(source.localPath), remoteEndpoint(config, source));
    await mutagen(deps, args);
}

// the `mutagen sync create` argument vector (one-way replica, posix symlinks)
function createArgs(name: string, localPath: string, endpoint: string): string[] {
    return [
        'sync',
        'create',
        `--name=${name}`,
        '--mode=one-way-replica',
        '--symlink-mode=posix-raw',
        localPath,
        endpoint,
    ];
}

// -- stop ---------------------------------------------------------------------

// pause every enabled session that currently exists
export async function syncStop(rawDeps: SyncDeps = {}): Promise<void> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const config = await loadConfig(deps.configDir);
    const existing = await listSessions(deps);

    for (const source of enabledSources(config)) {
        const name = mutagenSessionName(config, source);
        if (mutagenSessionExists(existing, name)) await mutagen(deps, ['sync', 'pause', name]);
    }
}

// -- status -------------------------------------------------------------------

// the full parsed session list from `mutagen sync list --long`
export async function syncStatus(rawDeps: SyncDeps = {}): Promise<SessionInfo[]> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const output = await mutagen(deps, ['sync', 'list', '--long']);
    return parseMutagenSessions(output);
}

// -- list ---------------------------------------------------------------------

// a configured-source view: its config state crossed with its live sync state
export type SyncListEntry = {
    source: string;
    sourceState: 'enabled' | 'disabled' | 'orphan';
    session: string;
    syncState: string;
    localPath?: string;
    remoteEndpoint?: string;
};

// list each configured source (+ any orphaned owned sessions) with its state
export async function syncList(rawDeps: SyncDeps = {}): Promise<SyncListEntry[]> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const config = await loadConfig(deps.configDir);
    const list = await listSessions(deps);

    const entries: SyncListEntry[] = [];
    const seen = new Set<string>();

    // one entry per configured source
    for (const source of config.sources) {
        const session = mutagenSessionName(config, source);
        seen.add(session);
        entries.push({
            source: source.agent,
            sourceState: source.enabled ? 'enabled' : 'disabled',
            session,
            syncState: mutagenSessionStatus(list, session) ?? 'missing',
            localPath: source.localPath,
            remoteEndpoint: remoteEndpoint(config, source),
        });
    }

    // surface owned sessions that no longer map to a configured source
    for (const session of ownedMutagenSessionNames(list, config.hostId)) {
        if (seen.has(session)) continue;
        entries.push({
            source: session.split('-').pop() ?? session,
            sourceState: 'orphan',
            session,
            syncState: mutagenSessionStatus(list, session) ?? 'unknown',
        });
    }

    return entries;
}

// -- reset --------------------------------------------------------------------

// terminate every owned session, then start enabled sources fresh
export async function syncReset(rawDeps: SyncDeps = {}): Promise<void> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const config = await loadConfig(deps.configDir);
    const existing = await listSessions(deps);

    // tear down anything this host owns
    for (const name of ownedMutagenSessionNames(existing, config.hostId)) {
        if (mutagenSessionExists(existing, name)) await mutagen(deps, ['sync', 'terminate', name]);
    }

    // then rebuild from the enabled sources
    await syncStart(rawDeps);
}

// -- source add / list --------------------------------------------------------

// add or update a configured source, persist, and start/pause its session
export async function sourceAdd(
    name: string,
    path: string,
    enabled: boolean,
    rawDeps: SyncDeps = {},
): Promise<{ existed: boolean }> {
    const deps = resolveDeps(rawDeps);
    const config = await loadConfig(deps.configDir);

    // mutate + persist the config first
    const existed = upsertSource(config, name, path, enabled);
    await saveConfig(config, deps.configDir);

    // best-effort apply the session change (don't fail the add on mutagen issues)
    const source = findSource(config, name)!;
    if (enabled && (await deps.commandExists('mutagen'))) {
        const existing = await listSessions(deps);
        await prepareRemoteWorkspace(deps, config);
        await startSource(deps, config, source, existing);
    }

    return { existed };
}

// the configured sources (raw config view, no mutagen calls)
export async function sourceList(rawDeps: SyncDeps = {}): Promise<Source[]> {
    const deps = resolveDeps(rawDeps);
    const config = await loadConfig(deps.configDir);
    return config.sources;
}
