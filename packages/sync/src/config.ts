// =============================================================================
// config — the ~/.ultracontext sync config (remote target, host id, sources)
// stored as JSON with atomic writes (temp + rename). Also home/path helpers,
// RemoteSpec parsing, source mutators, and the derived mutagen/remote helpers.
// =============================================================================

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

// -- types --------------------------------------------------------------------

// one synced agent: its on-disk location + whether sync is currently running
export type Source = {
    agent: string;
    localPath: string;
    enabled: boolean;
};

// the whole workspace config: where context lives + which agents feed it
export type Config = {
    remote: string;
    remoteRoot: string;
    hostId: string;
    sources: Source[];
};

// a parsed `[target][:root]` remote argument
export type RemoteSpec = {
    target: string;
    root: string;
};

// the default remote root when none is given
const DEFAULT_REMOTE_ROOT = '~/.ultracontext';

// -- paths --------------------------------------------------------------------

// root config dir: ~/.ultracontext (overridable so tests never touch $HOME)
export const configDir = (): string => join(homedir(), '.ultracontext');

// the JSON config file inside a given config dir
export const configPath = (dir: string = configDir()): string => join(dir, 'config.json');

// -- home expansion -----------------------------------------------------------

// expand a leading `~` to the user's home directory
export function expandHome(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
}

// -- atomic JSON i/o ----------------------------------------------------------

// write the config as JSON atomically (temp sibling + rename) into `dir`
export async function saveConfig(config: Config, dir: string = configDir()): Promise<void> {
    const path = configPath(dir);
    await mkdir(dirname(path), { recursive: true });

    // unique temp sibling so concurrent writers don't collide
    const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, path);
}

// read + validate the config; throws when absent or malformed
export async function loadConfig(dir: string = configDir()): Promise<Config> {
    const path = configPath(dir);

    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        throw new Error(`no sync config at ${path} — run \`uc sync init\``);
    }

    const config = JSON.parse(raw) as Config;
    validateConfig(config);
    return config;
}

// guard the shape we depend on across the orchestration
function validateConfig(config: Config): void {
    if (!config.remote) throw new Error('config missing remote');
    if (!config.hostId) throw new Error('config missing host_id');
    config.sources ??= [];
    for (const source of config.sources) validateSourceName(source.agent);
}

// -- RemoteSpec ---------------------------------------------------------------

// parse `target` or `target:root` into a RemoteSpec, defaulting the root
export function parseRemoteSpec(input: string): RemoteSpec {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('remote cannot be empty');

    // only split on `:` when the part before it has no slash (so `/srv` paths stay whole)
    const split = splitRemoteRoot(trimmed);
    if (split) {
        if (!split.target || !split.root) throw new Error(`invalid remote: ${trimmed}`);
        return split;
    }

    return { target: trimmed, root: DEFAULT_REMOTE_ROOT };
}

// split `target:root` when the colon separates a slash-free target from a root
function splitRemoteRoot(input: string): RemoteSpec | null {
    const colon = input.indexOf(':');
    if (colon < 0) return null;

    const before = input.slice(0, colon);
    const after = input.slice(colon + 1);
    if (before.includes('/') || !after) return null;

    return { target: before, root: after };
}

// the workspace lives on this machine when the remote is the literal `local`
export const isLocalConfig = (config: Config): boolean => config.remote === 'local';

// -- source mutators ----------------------------------------------------------

// add or update a source by agent name; returns true when it already existed
export function upsertSource(config: Config, name: string, path: string, enabled: boolean): boolean {
    validateSourceName(name);
    const existing = config.sources.find((source) => source.agent === name);

    if (existing) {
        existing.localPath = path;
        existing.enabled = enabled;
        return true;
    }

    config.sources.push({ agent: name, localPath: path, enabled });
    return false;
}

// drop a source by name; throws when no such source exists
export function removeSource(config: Config, name: string): void {
    validateSourceName(name);
    const before = config.sources.length;
    config.sources = config.sources.filter((source) => source.agent !== name);
    if (config.sources.length === before) throw new Error(`source not found: ${name}`);
}

// flip a source's enabled flag; throws when no such source exists
export function setSourceEnabled(config: Config, name: string, enabled: boolean): void {
    validateSourceName(name);
    const source = findSource(config, name);
    if (!source) throw new Error(`source not found: ${name}`);
    source.enabled = enabled;
}

// look up a source by agent name (undefined when absent)
export function findSource(config: Config, name: string): Source | undefined {
    return config.sources.find((source) => source.agent === name);
}

// the subset of sources that are currently enabled
export function enabledSources(config: Config): Source[] {
    return config.sources.filter((source) => source.enabled);
}

// names: letters/numbers/hyphens/underscores, ≤64 chars, alphanumeric first char
export function validateSourceName(name: string): void {
    if (!name) throw new Error('source name cannot be empty');
    if (name.length > 64) throw new Error(`source name too long: ${name}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`invalid source name: ${name}. Use letters, numbers, hyphens, and underscores.`);
    }
}

// -- derived helpers ----------------------------------------------------------

// the mutagen session name we own for a source: `uc-<hostId>-<agent>`
export function mutagenSessionName(config: Config, source: Source): string {
    return `uc-${config.hostId}-${source.agent}`;
}

// the remote leaf directory name for a source (last path segment of `~/.x`)
function remoteSourceDirName(source: Source): string {
    return source.localPath.replace(/\/+$/, '').split('/').pop() ?? source.agent;
}

// the per-source remote dir under this host's workspace
function remoteDir(config: Config, source: Source): string {
    return `${config.remoteRoot}/workspace/${config.hostId}/${remoteSourceDirName(source)}`;
}

// the mutagen beta endpoint for a source — a path (local) or `target:path` (ssh)
export function remoteEndpoint(config: Config, source: Source): string {
    const dir = remoteDir(config, source);
    return isLocalConfig(config) ? expandHome(dir) : `${config.remote}:${dir}`;
}

// -- host id ------------------------------------------------------------------

// derive a stable, filesystem-safe host id from a raw hostname string
export function defaultHostId(raw: string): string {
    return sanitizeId(raw.trim());
}

// lowercase, collapse non-alphanumerics to single dashes, trim edge dashes
function sanitizeId(value: string): string {
    const out = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return out || 'local';
}
