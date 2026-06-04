// =============================================================================
// remote — the unified "remote" view over the EXISTING config.json keys. ONE
// central machine carrying the coordinates each primitive needs: an ssh side
// {target, root, hostId} (fs sync + the event transport) and an api side
// {baseUrl, apiKey} (contexts/events over HTTP). No schema rewrite — this just
// projects/merges the existing keys (remote/remoteRoot/hostId + baseUrl/apiKey),
// preserving everything else (notably the sync `sources` array).
// =============================================================================

import { join } from 'node:path';

import { configDir, readJson, writeJsonAtomic } from './config';

// -- unified view -------------------------------------------------------------

// the ssh leg — an SSH target, its remote root, and this host's id
export type RemoteSsh = { target: string; root: string; hostId: string };

// the api leg — the HTTP base url + the bearer key
export type RemoteApi = { baseUrl: string; apiKey: string };

// the unified remote: either side optional (set ssh now, api later)
export type RemoteConfig = { ssh?: RemoteSsh; api?: RemoteApi };

// -- raw persisted shape ------------------------------------------------------

// the subset of config.json this module touches — everything else is preserved
type RawConfig = {
    remote?: string;
    remoteRoot?: string;
    hostId?: string;
    baseUrl?: string;
    apiKey?: string;
    [key: string]: unknown;
};

// the config.json path inside a given config dir (defaults to ~/.ultracontext)
const remoteConfigPath = (dir: string = configDir()): string => join(dir, 'config.json');

// -- read ---------------------------------------------------------------------

// project the existing config.json keys into the unified remote view
export async function readRemote(dir: string = configDir()): Promise<RemoteConfig> {
    const raw = await readJson<RawConfig>(remoteConfigPath(dir));
    if (!raw) return {};

    // surface only the sides whose keys are actually present
    const remote: RemoteConfig = {};
    if (raw.remote) remote.ssh = { target: raw.remote, root: raw.remoteRoot ?? '~/.ultracontext', hostId: raw.hostId ?? '' };
    if (raw.baseUrl && raw.apiKey) remote.api = { baseUrl: raw.baseUrl, apiKey: raw.apiKey };
    return remote;
}

// -- write --------------------------------------------------------------------

// merge a unified remote onto the existing config.json (atomic). Either side is
// written independently, so an api-only write keeps the ssh keys and vice-versa;
// untouched keys (e.g. the sync `sources` array) survive verbatim.
export async function writeRemote(remote: RemoteConfig, dir: string = configDir()): Promise<void> {
    const raw = (await readJson<RawConfig>(remoteConfigPath(dir))) ?? {};

    // ssh side → the {remote, remoteRoot, hostId} keys
    if (remote.ssh) {
        raw.remote = remote.ssh.target;
        raw.remoteRoot = remote.ssh.root;
        raw.hostId = remote.ssh.hostId;
    }

    // api side → the {baseUrl, apiKey} keys
    if (remote.api) {
        raw.baseUrl = remote.api.baseUrl;
        raw.apiKey = remote.api.apiKey;
    }

    await writeJsonAtomic(remoteConfigPath(dir), raw);
}

// -- clear --------------------------------------------------------------------

// the keys `uc remote` owns — cleared together, leaving everything else (sources)
const REMOTE_KEYS = ['remote', 'remoteRoot', 'hostId', 'baseUrl', 'apiKey'] as const;

// drop every remote coordinate, preserving the rest of the config (sources etc.)
export async function clearRemote(dir: string = configDir()): Promise<void> {
    const raw = await readJson<RawConfig>(remoteConfigPath(dir));
    if (!raw) return;

    // strip only the remote keys, then persist the remainder atomically
    for (const key of REMOTE_KEYS) delete raw[key];
    await writeJsonAtomic(remoteConfigPath(dir), raw);
}
