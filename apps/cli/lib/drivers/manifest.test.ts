// =============================================================================
// manifest.test — driver discovery + parse. Drives temp configDir fixtures (a
// drivers/ dir holding <name>/driver.toml). Asserts: driversDir joins
// <configDir>/drivers; listDrivers parses every valid manifest (sorted, dirs
// without driver.toml skipped); a bad manifest surfaces as a per-driver error,
// never a crash; loadDriver returns a manifest or a clear not-found error;
// name must be kebab-case AND match its directory name.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { driversDir, listDrivers, loadDriver } from './manifest';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-driver-manifest-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- fixtures -----------------------------------------------------------------

// the documented claude-web shape, with safe shell commands for run tests
const claudeWebToml = `name = "claude-web"
version = "0.1.0"
type = "external-app-sync"
runtime = "python"

[capabilities]
events = true
artifacts = true
bounded_sync = true
requires_logged_in_browser = true

[commands]
opened = "true"
poll = "echo polled"
doctor = "false"
`;

// write a driver fixture: <configDir>/drivers/<dirName>/driver.toml = toml
async function writeDriver(configDir: string, dirName: string, toml: string): Promise<void> {
    const dir = join(configDir, 'drivers', dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'driver.toml'), toml, 'utf8');
}

// -- driversDir ---------------------------------------------------------------

describe('driversDir', () => {
    // resolves <configDir>/drivers
    it('joins configDir with drivers', () => {
        assert.equal(driversDir('/tmp/x'), join('/tmp/x', 'drivers'));
    });
});

// -- listDrivers --------------------------------------------------------------

describe('listDrivers', () => {
    // a missing drivers dir → empty list, not an error
    it('returns empty when no drivers dir exists', async () => {
        const dir = await tempDir();
        const out = await listDrivers({ configDir: dir });
        assert.deepEqual(out, []);
    });

    // parses a valid manifest into the typed shape
    it('parses a valid manifest', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'claude-web', claudeWebToml);

        const out = await listDrivers({ configDir: dir });

        assert.equal(out.length, 1);
        assert.equal(out[0].name, 'claude-web');
        assert.equal(out[0].version, '0.1.0');
        assert.equal(out[0].type, 'external-app-sync');
        assert.equal(out[0].runtime, 'python');
        assert.deepEqual(out[0].capabilities, {
            events: true,
            artifacts: true,
            bounded_sync: true,
            requires_logged_in_browser: true,
        });
        assert.deepEqual(out[0].commands, { opened: 'true', poll: 'echo polled', doctor: 'false' });
        assert.equal(out[0].dir, join(dir, 'drivers', 'claude-web'));
    });

    // dirs WITHOUT a driver.toml are skipped (not every dir is a driver)
    it('skips dirs without driver.toml', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'claude-web', claudeWebToml);
        await mkdir(join(dir, 'drivers', 'not-a-driver'), { recursive: true });

        const out = await listDrivers({ configDir: dir });

        assert.equal(out.length, 1);
        assert.equal(out[0].name, 'claude-web');
    });

    // results are sorted by name for a stable surface
    it('sorts by name', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'zeta-web', claudeWebToml.replace('claude-web', 'zeta-web'));
        await writeDriver(dir, 'alpha-web', claudeWebToml.replace('claude-web', 'alpha-web'));

        const out = await listDrivers({ configDir: dir });

        assert.deepEqual(out.map((d) => d.name), ['alpha-web', 'zeta-web']);
    });

    // a manifest missing name surfaces as a per-driver error, never a crash
    it('reports a per-driver error for a manifest missing name', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'broken', 'version = "0.1.0"\n');

        const out = await listDrivers({ configDir: dir });

        assert.equal(out.length, 1);
        assert.ok(out[0].error);
        assert.match(out[0].error!, /missing name/);
        // the manifest body is NEVER echoed on an error path (no secrets leaked)
        assert.doesNotMatch(out[0].error!, /0\.1\.0/);
    });

    // a name/dir mismatch surfaces as a per-driver error
    it('reports a per-driver error for name/dir mismatch', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'wrong-dir', claudeWebToml);

        const out = await listDrivers({ configDir: dir });

        assert.equal(out.length, 1);
        assert.ok(out[0].error);
        assert.match(out[0].error!, /does not match directory/);
    });

    // a parse failure surfaces as a per-driver error, never a crash
    it('reports a per-driver error for invalid toml', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'badtoml', 'name = "badtoml\nthis is = = not toml');

        const out = await listDrivers({ configDir: dir });

        assert.equal(out.length, 1);
        assert.ok(out[0].error);
    });
});

// -- loadDriver ---------------------------------------------------------------

describe('loadDriver', () => {
    // loads a valid driver by name
    it('loads a valid driver', async () => {
        const dir = await tempDir();
        await writeDriver(dir, 'claude-web', claudeWebToml);

        const manifest = await loadDriver('claude-web', { configDir: dir });

        assert.equal(manifest.name, 'claude-web');
        assert.deepEqual(manifest.commands.poll, 'echo polled');
    });

    // a missing driver dir → a clear not-found error
    it('throws a clear error for a missing driver', async () => {
        const dir = await tempDir();
        await assert.rejects(() => loadDriver('nope', { configDir: dir }), /driver not found: nope/);
    });

    // a non-kebab name is rejected before touching the filesystem
    it('rejects a non-kebab name', async () => {
        const dir = await tempDir();
        await assert.rejects(() => loadDriver('Bad_Name', { configDir: dir }), /invalid driver name/);
    });
});
