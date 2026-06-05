// =============================================================================
// sync — fs-first orchestration over the `mutagen` binary. start/stop/status/
// reset/list call mutagen through an injectable CommandRunner (so tests use a
// fake binary). Source add/list mutate the config + apply the matching session.
// =============================================================================

import { mkdir } from 'node:fs/promises';

import {
    loadConfig,
    saveConfig,
    configDir as defaultConfigDir,
    enabledSources,
    isLocalConfig,
    mutagenSessionName,
    remoteEndpoint,
    expandHome,
    upsertSource,
    removeSource,
    setSourceEnabled,
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
import { ensureIgnoreFiles, collectIgnorePatterns } from './ignores';

// -- injectable dependencies --------------------------------------------------

// the seams the orchestration touches — all faked in tests
export type SyncDeps = {
    configDir?: string;
    runCommand?: CommandRunner;
    commandExists?: (name: string) => Promise<boolean>;
    pathExists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
};

// fill SyncDeps with the real implementations (spawn + fs probes + real config dir).
// warn defaults to stderr so one-time notices (e.g. the toml→json config migration)
// are never silent on the real CLI, while tests inject a capture hook.
function resolveDeps(deps: SyncDeps = {}): Required<SyncDeps> {
    return {
        configDir: deps.configDir ?? defaultConfigDir(),
        runCommand: deps.runCommand ?? spawnRunner,
        commandExists: deps.commandExists ?? realCommandExists,
        pathExists: deps.pathExists ?? realPathExists,
        warn: deps.warn ?? ((message) => process.stderr.write(`${message}\n`)),
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

// single-quote a path for a remote POSIX shell — the only char needing escape
// inside single quotes is the quote itself ('\''). Paths flow from user config
// (source names / localPath leaves / hostId), so NOTHING goes into a remote
// command unquoted: a leaf like `x; rm -rf ~` must stay an inert filename.
function shellQuote(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

// quote a remote path so it BOTH expands `~` remotely AND stays injection-safe:
// a leading `~/` (or bare `~`) becomes an unquoted `$HOME/` (the remote shell
// expands it) while the user-controlled remainder is single-quoted (inert).
// mutagen's own endpoint string expands `~` itself, so the two must NOT diverge.
function remotePath(dir: string): string {
    // bare `~` → just the expanded home directory
    if (dir === '~') return '$HOME';

    // `~/<rest>` → `$HOME/` + the quoted remainder (so a hostile leaf stays inert)
    if (dir.startsWith('~/')) return `$HOME/${shellQuote(dir.slice(2))}`;

    // any other path (absolute or relative) is quoted whole, as before
    return shellQuote(dir);
}

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

    // remote workspace → one ssh `mkdir -p`; each dir expands `~`→`$HOME` remotely
    // while its user-controlled remainder stays single-quoted (injection-safe)
    const result = await deps.runCommand('ssh', [config.remote, `mkdir -p ${dirs.map(remotePath).join(' ')}`]);
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

    const config = await loadConfig(deps.configDir, { warn: deps.warn });
    const existing = await listSessions(deps);
    await prepareRemoteWorkspace(deps, config);

    // seed the global ignore file so its defaults flow into every create
    await ensureIgnoreFiles({ configDir: deps.configDir });

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

    // gather this source's merged ignore patterns (global + per-source)
    const ignores = await collectIgnorePatterns({ configDir: deps.configDir }, source.agent);

    // otherwise create a one-way replica from the local path to the remote.
    // a create failure is per-source best-effort — surface it via deps.warn (so
    // the CLI never returns ok while silently creating no session) but don't
    // abort the whole start, so the remaining sources still get a chance.
    const args = createArgs(name, expandHome(source.localPath), remoteEndpoint(config, source), ignores);
    try {
        await mutagen(deps, args);
    } catch (error) {
        deps.warn(`sync: failed to start source "${source.agent}": ${(error as Error).message}`);
    }
}

// the `mutagen sync create` argument vector (one-way replica, posix symlinks)
function createArgs(name: string, localPath: string, endpoint: string, ignores: string[]): string[] {
    // the fixed flags, then one repeated `--ignore=` per pattern, then the endpoints
    return [
        'sync',
        'create',
        `--name=${name}`,
        '--mode=one-way-replica',
        '--symlink-mode=posix-raw',
        ...ignores.map((pattern) => `--ignore=${pattern}`),
        localPath,
        endpoint,
    ];
}

// -- stop ---------------------------------------------------------------------

// pause every enabled session that currently exists
export async function syncStop(rawDeps: SyncDeps = {}): Promise<void> {
    const deps = resolveDeps(rawDeps);
    await requireMutagen(deps);

    const config = await loadConfig(deps.configDir, { warn: deps.warn });
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

    const config = await loadConfig(deps.configDir, { warn: deps.warn });
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

    const config = await loadConfig(deps.configDir, { warn: deps.warn });
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
    const config = await loadConfig(deps.configDir, { warn: deps.warn });

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
    const config = await loadConfig(deps.configDir, { warn: deps.warn });
    return config.sources;
}

// -- source remove ------------------------------------------------------------

// options for removing a source (remote-dir deletion is opt-in + destructive)
export type SourceRemoveOptions = {
    purgeRemote?: boolean;
};

// terminate a source's session, drop it from config, optionally purge the remote dir
export async function sourceRemove(
    name: string,
    opts: SourceRemoveOptions = {},
    rawDeps: SyncDeps = {},
): Promise<void> {
    const deps = resolveDeps(rawDeps);
    const config = await loadConfig(deps.configDir, { warn: deps.warn });

    // resolve the source first so an unknown name is a clean error
    const source = findSource(config, name);
    if (!source) throw new Error(`source not found: ${name}`);

    // best-effort terminate the owned session when mutagen is installed
    if (await deps.commandExists('mutagen')) {
        const existing = await listSessions(deps);
        const session = mutagenSessionName(config, source);
        if (mutagenSessionExists(existing, session)) await mutagen(deps, ['sync', 'terminate', session]);
    }

    // delete the remote copy ONLY behind the explicit (destructive) opt-in
    if (opts.purgeRemote === true) await deleteRemoteSourceDir(deps, config, source);

    // drop the source from config + persist (local files are left untouched)
    removeSource(config, name);
    await saveConfig(config, deps.configDir);
}

// delete a source's remote dir — local: rmdir here; ssh: a guarded remote `rm -rf`
async function deleteRemoteSourceDir(deps: Required<SyncDeps>, config: Config, source: Source): Promise<void> {
    const dir = endpointDir(config, source);

    // the now-orphaned per-host parent (workspace/<host>) — pruned only WHEN EMPTY
    // so removing one source's data doesn't strand an empty host dir, while a host
    // with other sources is left untouched (rmdir refuses a non-empty dir)
    const parent = dir.split('/').slice(0, -1).join('/');

    // local workspace → remove the directory on this machine, then rmdir the
    // empty parent (best-effort; fails silently when other sources remain)
    if (isLocalConfig(config)) {
        const { rm, rmdir } = await import('node:fs/promises');
        await rm(expandHome(dir), { recursive: true, force: true });
        await rmdir(expandHome(parent)).catch(() => {});
        return;
    }

    // remote workspace → one guarded ssh `rm -rf` + an `rmdir` of the parent; the
    // paths expand `~`→`$HOME` remotely (so they hit the real data dir) while the
    // remainder stays quoted so a crafted source/leaf can never break out. rmdir
    // only removes the parent if it is EMPTY, so a shared host dir is preserved.
    const target = remotePath(dir);
    const parentTarget = remotePath(parent);
    const command = `if [ -e ${target} ]; then rm -rf ${target}; fi; rmdir ${parentTarget} 2>/dev/null || true`;
    const result = await deps.runCommand('ssh', [config.remote, command]);
    if (result.code !== 0) throw new Error(`ssh rm failed: ${result.stderr.trim()}`);
}

// -- source enable / disable --------------------------------------------------

// flip a source's enabled flag, persist, then best-effort apply the session change
export async function sourceSetEnabled(
    name: string,
    enabled: boolean,
    rawDeps: SyncDeps = {},
): Promise<void> {
    const deps = resolveDeps(rawDeps);
    const config = await loadConfig(deps.configDir, { warn: deps.warn });

    // mutate + persist the flag first (throws on an unknown name)
    setSourceEnabled(config, name, enabled);
    await saveConfig(config, deps.configDir);

    // best-effort apply: enable → start the session; disable → pause it
    const source = findSource(config, name)!;
    if (!(await deps.commandExists('mutagen'))) return;

    if (enabled) {
        const existing = await listSessions(deps);
        await prepareRemoteWorkspace(deps, config);
        await ensureIgnoreFiles({ configDir: deps.configDir });
        await startSource(deps, config, source, existing);
    } else {
        const existing = await listSessions(deps);
        const session = mutagenSessionName(config, source);
        if (mutagenSessionExists(existing, session)) await mutagen(deps, ['sync', 'pause', session]);
    }
}
