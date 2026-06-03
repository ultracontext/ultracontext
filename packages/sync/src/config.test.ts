// =============================================================================
// config.test — the ~/.ultracontext sync config: JSON round-trip (atomic
// write → read), RemoteSpec parsing, source mutators, and the derived mutagen
// session-name / remote-endpoint helpers. Writes go to a temp dir, never $HOME.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    parseRemoteSpec,
    isLocalConfig,
    loadConfig,
    saveConfig,
    upsertSource,
    removeSource,
    setSourceEnabled,
    findSource,
    enabledSources,
    mutagenSessionName,
    remoteEndpoint,
    defaultHostId,
    type Config,
} from './config';

// -- temp dirs ----------------------------------------------------------------

// track temp config dirs so we can clean them all up at the end of the suite
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-sync-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// a minimal valid config for the mutators / helpers
function sampleConfig(): Config {
    return {
        remote: 'user@vps',
        remoteRoot: '~/.ultracontext',
        hostId: 'laptop',
        sources: [{ agent: 'claude', localPath: '~/.claude', enabled: true }],
    };
}

// -- RemoteSpec ---------------------------------------------------------------

describe('parseRemoteSpec', () => {
    // a bare SSH target gets the default remote root
    it('defaults the root for a bare target', () => {
        assert.deepEqual(parseRemoteSpec('user@example.com'), {
            target: 'user@example.com',
            root: '~/.ultracontext',
        });
    });

    // `target:/path` splits into target + explicit root
    it('splits an explicit root', () => {
        assert.deepEqual(parseRemoteSpec('user@example.com:/srv/uc'), {
            target: 'user@example.com',
            root: '/srv/uc',
        });
    });

    // `local` is a valid bare target (workspace lives on this machine)
    it('accepts local', () => {
        assert.deepEqual(parseRemoteSpec('local'), { target: 'local', root: '~/.ultracontext' });
    });

    // empty input is rejected
    it('rejects empty input', () => {
        assert.throws(() => parseRemoteSpec('   '));
    });
});

// -- JSON round-trip ----------------------------------------------------------

describe('config round-trip', () => {
    // save → load returns an equal config, and the file is valid JSON
    it('round-trips through an atomic write', async () => {
        const dir = await tempDir();
        const config = sampleConfig();

        await saveConfig(config, dir);
        const loaded = await loadConfig(dir);

        assert.deepEqual(loaded, config);

        // the on-disk artifact is real JSON at config.json
        const raw = await readFile(join(dir, 'config.json'), 'utf8');
        assert.deepEqual(JSON.parse(raw), config);
    });

    // loading from an empty dir throws (no config yet → run `uc sync init`)
    it('throws when no config exists', async () => {
        const dir = await tempDir();
        await assert.rejects(loadConfig(dir));
    });
});

// -- toml → json migration ----------------------------------------------------

// a config.toml matching the LIVE mini shape (top-level + [query] + [sources.*])
const LIVE_TOML = `remote = "uc"
remote_root = "~/.ultracontext"
host_id = "fabios-mac-mini"

[query]
command = "claude"
args = "-p {{prompt}}"

[sources.claude]
path = "~/.claude"
enabled = true

[sources.codex]
path = "~/.codex"
enabled = false
`;

describe('config.toml migration', () => {
    // when only config.toml exists, loadConfig migrates it to config.json
    it('migrates a legacy config.toml to config.json', async () => {
        const dir = await tempDir();
        await writeFile(join(dir, 'config.toml'), LIVE_TOML, 'utf8');

        const warnings: string[] = [];
        const config = await loadConfig(dir, { warn: (m) => warnings.push(m) });

        // the mapped Config carries the top-level fields + sources
        assert.equal(config.remote, 'uc');
        assert.equal(config.remoteRoot, '~/.ultracontext');
        assert.equal(config.hostId, 'fabios-mac-mini');
        assert.deepEqual(
            config.sources,
            [
                { agent: 'claude', localPath: '~/.claude', enabled: true },
                { agent: 'codex', localPath: '~/.codex', enabled: false },
            ],
        );

        // the [query] table is preserved (not dropped)
        assert.deepEqual(config.query, { command: 'claude', args: '-p {{prompt}}' });

        // exactly one migration line was logged to the injected warn hook
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /migrat/i);
    });

    // migration writes config.json and renames config.toml → config.toml.migrated
    it('writes config.json and renames the toml', async () => {
        const dir = await tempDir();
        await writeFile(join(dir, 'config.toml'), LIVE_TOML, 'utf8');

        await loadConfig(dir, { warn: () => {} });

        // config.json now exists and round-trips the migrated config
        const raw = await readFile(join(dir, 'config.json'), 'utf8');
        const onDisk = JSON.parse(raw);
        assert.equal(onDisk.remote, 'uc');
        assert.deepEqual(onDisk.query, { command: 'claude', args: '-p {{prompt}}' });

        // the original toml is kept under a .migrated suffix (never deleted)
        await access(join(dir, 'config.toml.migrated'));
        await assert.rejects(access(join(dir, 'config.toml')));
    });

    // a second load reads config.json and does NOT re-run the migration
    it('does not re-run migration once config.json exists', async () => {
        const dir = await tempDir();
        await writeFile(join(dir, 'config.toml'), LIVE_TOML, 'utf8');
        await loadConfig(dir, { warn: () => {} });

        // re-introduce a config.toml — config.json should win, no warn fires
        await writeFile(join(dir, 'config.toml'), LIVE_TOML, 'utf8');
        const warnings: string[] = [];
        const config = await loadConfig(dir, { warn: (m) => warnings.push(m) });

        assert.equal(config.remote, 'uc');
        assert.equal(warnings.length, 0);
        // the freshly written toml is untouched (no second rename)
        await access(join(dir, 'config.toml'));
    });
});

// -- source mutators ----------------------------------------------------------

describe('source mutators', () => {
    // upsert adds a new source (returns false = did not previously exist)
    it('adds a new source', () => {
        const config = sampleConfig();
        const existed = upsertSource(config, 'codex', '~/.codex', true);
        assert.equal(existed, false);
        assert.equal(config.sources.length, 2);
        assert.deepEqual(findSource(config, 'codex'), { agent: 'codex', localPath: '~/.codex', enabled: true });
    });

    // upsert on an existing name updates path/enabled (returns true)
    it('updates an existing source', () => {
        const config = sampleConfig();
        const existed = upsertSource(config, 'claude', '~/.claude-new', false);
        assert.equal(existed, true);
        assert.equal(config.sources.length, 1);
        assert.equal(findSource(config, 'claude')?.localPath, '~/.claude-new');
        assert.equal(findSource(config, 'claude')?.enabled, false);
    });

    // enable/disable toggles the flag
    it('toggles enabled', () => {
        const config = sampleConfig();
        setSourceEnabled(config, 'claude', false);
        assert.equal(findSource(config, 'claude')?.enabled, false);
    });

    // remove drops the source; removing a missing one throws
    it('removes a source and rejects unknown names', () => {
        const config = sampleConfig();
        removeSource(config, 'claude');
        assert.equal(config.sources.length, 0);
        assert.throws(() => removeSource(config, 'nope'));
    });

    // invalid source names are rejected by the mutators
    it('rejects invalid source names', () => {
        const config = sampleConfig();
        assert.throws(() => upsertSource(config, 'bad name!', '~/x', true));
    });

    // enabledSources yields only the enabled entries
    it('iterates only enabled sources', () => {
        const config = sampleConfig();
        upsertSource(config, 'codex', '~/.codex', false);
        assert.deepEqual(enabledSources(config).map((s) => s.agent), ['claude']);
    });
});

// -- derived helpers ----------------------------------------------------------

describe('derived helpers', () => {
    // session name is `uc-<hostId>-<agent>`
    it('builds the mutagen session name', () => {
        const config = sampleConfig();
        assert.equal(mutagenSessionName(config, config.sources[0]), 'uc-laptop-claude');
    });

    // remote endpoint for an SSH target is `target:<root>/workspace/<host>/<dir>`
    it('builds an ssh remote endpoint', () => {
        const config = sampleConfig();
        const endpoint = remoteEndpoint(config, config.sources[0]);
        assert.equal(endpoint, 'user@vps:~/.ultracontext/workspace/laptop/.claude');
    });

    // a local workspace endpoint omits the `target:` prefix
    it('builds a local remote endpoint', () => {
        const config: Config = { ...sampleConfig(), remote: 'local' };
        assert.equal(isLocalConfig(config), true);
        const endpoint = remoteEndpoint(config, config.sources[0]);
        assert.match(endpoint, /\/\.ultracontext\/workspace\/laptop\/\.claude$/);
        assert.ok(!endpoint.includes('local:'));
    });
});

// -- host id ------------------------------------------------------------------

describe('defaultHostId', () => {
    // sanitizes to lowercase alphanumeric + dashes
    it('sanitizes a hostname', () => {
        assert.equal(defaultHostId('My Laptop.local'), 'my-laptop-local');
        assert.equal(defaultHostId('   '), 'local');
    });
});
