// =============================================================================
// remote.test — the unified remote view over the EXISTING config.json keys.
// readRemote projects {remote, remoteRoot, hostId} → ssh and {baseUrl, apiKey}
// → api; writeRemote merges either side back onto the same keys WITHOUT clobbering
// the other (ssh-only first, api-only later, both). Writes go to a temp dir.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRemote, writeRemote, clearRemote, type RemoteConfig } from './remote';
import { writeJsonAtomic } from './config';

// -- temp dirs ----------------------------------------------------------------

// track temp config dirs so the whole suite cleans up at the end
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-remote-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// read the raw config.json back as a plain object (null when absent)
async function rawConfig(dir: string): Promise<Record<string, unknown> | null> {
    try {
        return JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    } catch {
        return null;
    }
}

// -- readRemote ---------------------------------------------------------------

describe('readRemote', () => {
    // an absent config → an empty unified view (no ssh, no api)
    it('returns an empty view when no config exists', async () => {
        const dir = await tempDir();
        const remote = await readRemote(dir);
        assert.deepEqual(remote, {});
    });

    // ssh keys present → the ssh side surfaces (target/root/hostId)
    it('projects the ssh keys into the ssh side', async () => {
        const dir = await tempDir();
        await writeJsonAtomic(join(dir, 'config.json'), {
            remote: 'user@vps',
            remoteRoot: '/srv/uc',
            hostId: 'laptop',
            sources: [],
        });

        const remote = await readRemote(dir);
        assert.deepEqual(remote.ssh, { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' });
        assert.equal(remote.api, undefined);
    });

    // api keys present → the api side surfaces (baseUrl/apiKey)
    it('projects the api keys into the api side', async () => {
        const dir = await tempDir();
        await writeJsonAtomic(join(dir, 'config.json'), {
            baseUrl: 'https://api.example.com',
            apiKey: 'sk_x',
        });

        const remote = await readRemote(dir);
        assert.deepEqual(remote.api, { baseUrl: 'https://api.example.com', apiKey: 'sk_x' });
        assert.equal(remote.ssh, undefined);
    });

    // both sides coexist in the same config.json
    it('projects both sides when both are present', async () => {
        const dir = await tempDir();
        await writeJsonAtomic(join(dir, 'config.json'), {
            remote: 'user@vps',
            remoteRoot: '/srv/uc',
            hostId: 'laptop',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk_x',
        });

        const remote = await readRemote(dir);
        assert.equal(remote.ssh?.target, 'user@vps');
        assert.equal(remote.api?.baseUrl, 'https://api.example.com');
    });
});

// -- writeRemote --------------------------------------------------------------

describe('writeRemote', () => {
    // writing only the ssh side persists the ssh keys (no api keys appear)
    it('writes the ssh side without touching the api keys', async () => {
        const dir = await tempDir();
        await writeRemote({ ssh: { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' } }, dir);

        const raw = await rawConfig(dir);
        assert.equal(raw?.remote, 'user@vps');
        assert.equal(raw?.remoteRoot, '/srv/uc');
        assert.equal(raw?.hostId, 'laptop');
        assert.equal(raw?.baseUrl, undefined);
        assert.equal(raw?.apiKey, undefined);
    });

    // adding the api side later MERGES onto the existing ssh keys (no clobber)
    it('merges the api side onto an existing ssh config', async () => {
        const dir = await tempDir();
        await writeRemote({ ssh: { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' } }, dir);
        await writeRemote({ api: { baseUrl: 'https://api.example.com', apiKey: 'sk_x' } }, dir);

        const raw = await rawConfig(dir);
        // ssh keys survive the api write
        assert.equal(raw?.remote, 'user@vps');
        assert.equal(raw?.hostId, 'laptop');
        // api keys are now present too
        assert.equal(raw?.baseUrl, 'https://api.example.com');
        assert.equal(raw?.apiKey, 'sk_x');
    });

    // writing the ssh side preserves an existing sources array (live config shape)
    it('preserves an existing sources array', async () => {
        const dir = await tempDir();
        await writeJsonAtomic(join(dir, 'config.json'), {
            remote: 'local',
            remoteRoot: '~/.ultracontext',
            hostId: 'old',
            sources: [{ agent: 'claude', localPath: '~/.claude', enabled: true }],
        });

        await writeRemote({ ssh: { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' } }, dir);

        const raw = await rawConfig(dir);
        assert.deepEqual(raw?.sources, [{ agent: 'claude', localPath: '~/.claude', enabled: true }]);
        assert.equal(raw?.remote, 'user@vps');
    });

    // a round-trip through readRemote returns what was written
    it('round-trips both sides through readRemote', async () => {
        const dir = await tempDir();
        const remote: RemoteConfig = {
            ssh: { target: 'user@vps', root: '/srv/uc', hostId: 'laptop' },
            api: { baseUrl: 'https://api.example.com', apiKey: 'sk_x' },
        };
        await writeRemote(remote, dir);

        const loaded = await readRemote(dir);
        assert.deepEqual(loaded, remote);
    });
});

// -- clearRemote --------------------------------------------------------------

describe('clearRemote', () => {
    // clearing drops the remote coords but leaves sources intact
    it('drops remote coords and leaves sources alone', async () => {
        const dir = await tempDir();
        await writeJsonAtomic(join(dir, 'config.json'), {
            remote: 'user@vps',
            remoteRoot: '/srv/uc',
            hostId: 'laptop',
            baseUrl: 'https://api.example.com',
            apiKey: 'sk_x',
            sources: [{ agent: 'claude', localPath: '~/.claude', enabled: true }],
        });

        await clearRemote(dir);

        const raw = await rawConfig(dir);
        // every remote coordinate is gone
        assert.equal(raw?.remote, undefined);
        assert.equal(raw?.remoteRoot, undefined);
        assert.equal(raw?.hostId, undefined);
        assert.equal(raw?.baseUrl, undefined);
        assert.equal(raw?.apiKey, undefined);
        // sources are untouched
        assert.deepEqual(raw?.sources, [{ agent: 'claude', localPath: '~/.claude', enabled: true }]);
    });

    // clearing an absent config is a no-op (no throw)
    it('is a no-op when no config exists', async () => {
        const dir = await tempDir();
        await assert.doesNotReject(clearRemote(dir));
    });
});
