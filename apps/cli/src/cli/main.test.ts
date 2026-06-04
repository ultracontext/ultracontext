// =============================================================================
// main.test — smoke: the program parses without throwing + exposes the tree.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProgram, run, handleRootVersion } from './main';

// -- program shape ------------------------------------------------------------

describe('buildProgram', () => {
    // every top-level command group is registered
    it('registers all command groups', () => {
        const program = buildProgram();
        const names = program.commands.map((c) => c.name());

        for (const expected of ['create', 'append', 'get', 'update', 'delete', 'list', 'event', 'sync', 'remote', 'upgrade', 'doctor', 'init', 'commands', 'version']) {
            assert.ok(names.includes(expected), `missing command: ${expected}`);
        }
    });

    // the root must NOT register Commander's global --version — it would shadow
    // the `--version <n>` time-travel selector on the get/create verbs
    it('does not register a global --version flag', () => {
        const flags = buildProgram().options.map((o) => o.long);
        assert.ok(!flags.includes('--version'), 'root must not carry a global --version');
    });

    // sync exposes its subcommands — init is gone (it moved to `uc remote set`)
    it('registers sync subcommands', () => {
        const program = buildProgram();
        const sync = program.commands.find((c) => c.name() === 'sync');
        const subs = sync?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['start', 'stop', 'status', 'source']) {
            assert.ok(subs.includes(expected), `missing sync subcommand: ${expected}`);
        }
        assert.ok(!subs.includes('init'), 'sync init must be gone — it moved to `uc remote set`');
    });

    // the top-level remote group exposes its subcommands
    it('registers remote subcommands', () => {
        const program = buildProgram();
        const remote = program.commands.find((c) => c.name() === 'remote');
        const subs = remote?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['set', 'show', 'test', 'clear']) {
            assert.ok(subs.includes(expected), `missing remote subcommand: ${expected}`);
        }
    });

    // the top-level event group exposes its subcommands
    it('registers event subcommands', () => {
        const program = buildProgram();
        const event = program.commands.find((c) => c.name() === 'event');
        const subs = event?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['emit', 'tail', 'status', 'flush', 'commit']) {
            assert.ok(subs.includes(expected), `missing event subcommand: ${expected}`);
        }
    });
});

// -- smoke run ----------------------------------------------------------------

describe('run', () => {
    // parsing `commands --json` resolves without throwing
    it('parses `commands --json` without throwing', async () => {
        await assert.doesNotReject(run(['node', 'uc', 'commands', '--json']));
    });

    // a capturing stdout for the --version paths
    function captureOut() {
        let text = '';
        return { write: (s: string) => ((text += s), true), get: () => text };
    }

    // `uc --version` (root flag) prints the tool version — field/health checks
    // expect it; it must NOT shadow the `get --version <n>` time-travel selector
    it('prints the version for a root --version flag', async () => {
        const out = captureOut();
        await run(['node', 'uc', '--version'], { stdout: out });
        assert.match(out.get().trim(), /^\d+\.\d+\.\d+$/);
    });

    // -V short form too
    it('prints the version for -V', async () => {
        const out = captureOut();
        await run(['node', 'uc', '-V'], { stdout: out });
        assert.match(out.get().trim(), /^\d+\.\d+\.\d+$/);
    });

    // the leading-token rule (pure, no backend IO): a subcommand's `--version <n>`
    // must NOT be intercepted as the tool-version flag, while a root --version is
    it('intercepts root --version but not a subcommand --version', () => {
        const sink = captureOut();
        // root forms → intercepted (returns true, writes the version)
        assert.equal(handleRootVersion(['--version'], sink), true);
        assert.equal(handleRootVersion(['-V'], sink), true);
        assert.equal(handleRootVersion(['--json', '--version'], sink), true);
        // subcommand-led forms → NOT intercepted (leading token is the command)
        const sink2 = captureOut();
        assert.equal(handleRootVersion(['get', 'ctx_x', '--version', '0'], sink2), false);
        assert.equal(handleRootVersion(['create', '--version', '2'], sink2), false);
        assert.equal(sink2.get(), '', 'no version written for a subcommand --version');
    });
});
