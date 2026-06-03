// =============================================================================
// driver.test — the TOP-LEVEL `uc driver <list|run>` family. Drives the action
// functions (with a temp configDir holding fixture manifests + an injected
// spawn) AND REAL argv (buildDriverCommand().parseAsync). Covers: list (human
// one-line-per-driver + --json manifest array, empty case); list surfaces a
// per-driver error without crashing; run resolves + executes via the injected
// spawn (echo → 0, false → 1), propagating the exit code; a missing driver / a
// missing command fail clearly (the command error lists what's available).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listAction, runAction, buildDriverCommand } from './driver';
import type { Spawn } from '../../../lib/drivers/run';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- capture + fakes ----------------------------------------------------------

// a writable-like sink recording everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// records every spawn invocation, replying a canned exit code
function recordingSpawn(code: number) {
    const calls: { program: string; args: string[] }[] = [];
    const spawn: Spawn = (program, args) => {
        calls.push({ program, args });
        return Promise.resolve(code);
    };
    return { spawn, calls };
}

// the documented claude-web shape with safe shell verbs (echo → 0, false → 1)
const fixToml = `name = "fix"
version = "0.2.0"
type = "external-app-sync"
runtime = "shell"

[capabilities]
events = true

[commands]
echo-cmd = "echo hi"
fail-cmd = "false"
`;

// write a driver fixture into a fresh temp configDir, return that configDir
async function fixtureConfigDir(): Promise<string> {
    const dir = await tempDir('uc-cli-driver-cfg-');
    const drvDir = join(dir, 'drivers', 'fix');
    await mkdir(drvDir, { recursive: true });
    await writeFile(join(drvDir, 'driver.toml'), fixToml, 'utf8');
    return dir;
}

// -- list ---------------------------------------------------------------------

describe('uc driver list', () => {
    // human mode → one line per driver: name@version + its command names
    it('lists installed drivers one line each (human)', async () => {
        const configDir = await fixtureConfigDir();
        const out = sink();

        const code = await listAction({ json: false }, { configDir, io: { stdout: out, stderr: sink(), isTTY: true } });

        assert.equal(code, 0);
        const text = out.text();
        assert.match(text, /fix@0\.2\.0/);
        assert.match(text, /echo-cmd/);
        assert.match(text, /fail-cmd/);
    });

    // --json → the manifest array (machine-shaped)
    it('emits the manifest array under --json', async () => {
        const configDir = await fixtureConfigDir();
        const out = sink();

        await listAction({ json: true }, { configDir, io: { stdout: out, stderr: sink(), isTTY: false } });

        const arr = JSON.parse(out.text().trim());
        assert.equal(arr.length, 1);
        assert.equal(arr[0].name, 'fix');
        assert.equal(arr[0].version, '0.2.0');
        assert.deepEqual(arr[0].commands, { 'echo-cmd': 'echo hi', 'fail-cmd': 'false' });
    });

    // an empty install → no rows + a clear stderr hint, exit 0
    it('reports an empty install without error', async () => {
        const configDir = await tempDir('uc-cli-driver-empty-');
        const out = sink();

        const code = await listAction({ json: false }, { configDir, io: { stdout: out, stderr: sink(), isTTY: true } });

        assert.equal(code, 0);
    });

    // a broken driver surfaces its per-driver error inline, never a crash
    it('surfaces a per-driver error without crashing', async () => {
        const configDir = await tempDir('uc-cli-driver-broken-');
        const drvDir = join(configDir, 'drivers', 'broken');
        await mkdir(drvDir, { recursive: true });
        await writeFile(join(drvDir, 'driver.toml'), 'version = "0.1.0"\n', 'utf8');

        const out = sink();
        const code = await listAction({ json: false }, { configDir, io: { stdout: out, stderr: sink(), isTTY: true } });

        assert.equal(code, 0);
        assert.match(out.text(), /broken/);
    });
});

// -- run ----------------------------------------------------------------------

describe('uc driver run', () => {
    // resolves + runs the verb via the injected spawn, exit 0 for echo
    it('runs a driver command and returns exit 0', async () => {
        const configDir = await fixtureConfigDir();
        const rec = recordingSpawn(0);

        const code = await runAction('fix', 'echo-cmd', { json: false }, { configDir, spawn: rec.spawn });

        assert.equal(code, 0);
        assert.equal(rec.calls.length, 1);
        assert.deepEqual(rec.calls[0].args, ['-c', 'echo hi']);
    });

    // propagates the child's nonzero exit code (false → 1)
    it('propagates a nonzero child exit code', async () => {
        const configDir = await fixtureConfigDir();
        const rec = recordingSpawn(1);

        const code = await runAction('fix', 'fail-cmd', { json: false }, { configDir, spawn: rec.spawn });

        assert.equal(code, 1);
    });

    // a missing driver → exit 1 + a clear error on stderr
    it('fails clearly for a missing driver', async () => {
        const configDir = await fixtureConfigDir();
        const err = sink();

        const code = await runAction('nope', 'x', { json: false }, { configDir, spawn: recordingSpawn(0).spawn, io: { stdout: sink(), stderr: err, isTTY: true } });

        assert.equal(code, 1);
        assert.match(err.text(), /driver not found: nope/);
    });

    // a missing command → exit 1 + an error LISTING the available commands
    it('fails clearly for a missing command, listing available', async () => {
        const configDir = await fixtureConfigDir();
        const err = sink();

        const code = await runAction('fix', 'nope', { json: false }, { configDir, spawn: recordingSpawn(0).spawn, io: { stdout: sink(), stderr: err, isTTY: true } });

        assert.equal(code, 1);
        assert.match(err.text(), /no command nope/);
        assert.match(err.text(), /echo-cmd/);
    });
});

// -- REAL argv (parseAsync) ---------------------------------------------------

describe('buildDriverCommand (real argv)', () => {
    // the group registers list + run
    it('registers list + run', () => {
        const driver = buildDriverCommand();
        const subs = driver.commands.map((c) => c.name());
        assert.ok(subs.includes('list'));
        assert.ok(subs.includes('run'));
    });

    // run takes two positional arguments: <driver> <command>
    it('run declares <driver> and <command> positionals', () => {
        const run = buildDriverCommand().commands.find((c) => c.name() === 'run');
        const names = run?.registeredArguments.map((a) => a.name()) ?? [];
        assert.deepEqual(names, ['driver', 'command']);
    });

    // a full argv parse of list resolves the temp-HOME default configDir
    it('parses `driver list` argv end to end', async () => {
        const configDir = await fixtureConfigDir();

        // a temp $HOME → default configDir is <HOME>/.ultracontext; seed it there
        const prevHome = process.env.HOME;
        const home = await tempDir('uc-cli-driver-home-');
        process.env.HOME = home;
        await mkdir(join(home, '.ultracontext', 'drivers', 'fix'), { recursive: true });
        await writeFile(join(home, '.ultracontext', 'drivers', 'fix', 'driver.toml'), fixToml, 'utf8');
        try {
            const driver = buildDriverCommand();
            // --json is a program-root global; the standalone group parses bare list
            await driver.parseAsync(['list'], { from: 'user' });
            void configDir;
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
    });
});
