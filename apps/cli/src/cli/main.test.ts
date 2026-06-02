// =============================================================================
// main.test — smoke: the program parses without throwing + exposes the tree.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProgram, run } from './main';

// -- program shape ------------------------------------------------------------

describe('buildProgram', () => {
    // every top-level command group is registered
    it('registers all command groups', () => {
        const program = buildProgram();
        const names = program.commands.map((c) => c.name());

        for (const expected of ['add', 'get', 'update', 'delete', 'list', 'sync', 'upgrade', 'doctor', 'init', 'commands']) {
            assert.ok(names.includes(expected), `missing command: ${expected}`);
        }
    });

    // sync exposes its subcommands
    it('registers sync subcommands', () => {
        const program = buildProgram();
        const sync = program.commands.find((c) => c.name() === 'sync');
        const subs = sync?.commands.map((c) => c.name()) ?? [];

        for (const expected of ['init', 'start', 'stop', 'status', 'source', 'event']) {
            assert.ok(subs.includes(expected), `missing sync subcommand: ${expected}`);
        }
    });
});

// -- smoke run ----------------------------------------------------------------

describe('run', () => {
    // parsing `commands --json` resolves without throwing
    it('parses `commands --json` without throwing', async () => {
        await assert.doesNotReject(run(['node', 'uc', 'commands', '--json']));
    });
});
