// =============================================================================
// main.test — smoke: the program parses without throwing + exposes the tree.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProgram, run, handleRootVersion, unknownLeadingCommand } from './main';

// -- program shape ------------------------------------------------------------

describe('buildProgram', () => {
    // every top-level command group is registered
    it('registers all command groups', () => {
        const program = buildProgram();
        const names = program.commands.map((c) => c.name());

        for (const expected of ['context', 'event', 'mirror', 'remote', 'update', 'doctor', 'init', 'commands', 'version']) {
            assert.ok(names.includes(expected), `missing command: ${expected}`);
        }
    });

    // the root must NOT register Commander's global --version — it would shadow
    // the `--version <n>` time-travel selector on the get/create verbs
    it('does not register a global --version flag', () => {
        const flags = buildProgram().options.map((o) => o.long);
        assert.ok(!flags.includes('--version'), 'root must not carry a global --version');
    });

    // mirror exposes its subcommands — init is gone (it moved to `uc remote set`)
    // and the legacy `sync` alias is gone (the group answers only to `mirror`)
    it('registers mirror subcommands', () => {
        const program = buildProgram();
        const mirror = program.commands.find((c) => c.name() === 'mirror');
        const subs = mirror?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['start', 'stop', 'status', 'source']) {
            assert.ok(subs.includes(expected), `missing mirror subcommand: ${expected}`);
        }
        assert.ok(!subs.includes('init'), 'mirror init must be gone — it moved to `uc remote set`');
        assert.ok(!mirror?.aliases().includes('sync'), 'mirror group must NOT carry the legacy sync alias');
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

    // the context group exposes the SDK-mirroring verbs (alias: ctx) — the verbs
    // moved OFF the root so the primitive is explicit (`uc context append`)
    it('registers context subcommands under the group', () => {
        const program = buildProgram();
        const context = program.commands.find((c) => c.name() === 'context');
        const subs = context?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['create', 'append', 'get', 'update', 'delete', 'list']) {
            assert.ok(subs.includes(expected), `missing context subcommand: ${expected}`);
        }
        assert.ok(context?.aliases().includes('ctx'), 'context group carries the ctx alias');

        // the verbs are GONE from the root (no more bare `uc append`)
        const rootNames = program.commands.map((c) => c.name());
        for (const verb of ['create', 'append', 'get', 'delete']) {
            assert.ok(!rootNames.includes(verb), `verb ${verb} must not be top-level`);
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

    // the dead `sync` alias is an unknown leading command — flagged so it exits
    // non-zero even with a trailing `--help` (Commander would otherwise exit 0)
    it('flags the dead `sync` command (and other unknowns), not real ones', () => {
        const program = buildProgram();
        assert.equal(unknownLeadingCommand(['sync', '--help'], program), 'sync');
        assert.equal(unknownLeadingCommand(['bogusxyz'], program), 'bogusxyz');
        // real commands + aliases + flag-only argv are NOT flagged
        assert.equal(unknownLeadingCommand(['mirror', '--help'], program), undefined);
        assert.equal(unknownLeadingCommand(['ctx', 'list'], program), undefined);
        assert.equal(unknownLeadingCommand(['--json'], program), undefined);

        // Commander's implicit help command must pass the guard
        assert.equal(unknownLeadingCommand(['help'], program), undefined);
        assert.equal(unknownLeadingCommand(['help', 'mirror'], program), undefined);
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
