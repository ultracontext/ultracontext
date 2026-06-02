// =============================================================================
// commands.test — RED. `uc commands --json` walks the live Commander tree and
// emits it as a machine-readable JSON tree for agents. We assert the recursive
// shape (name/description/options/arguments/subcommands) against a small fake
// program so the serializer is verified independently of the real command set.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Command } from '@commander-js/extra-typings';

import { serializeProgram, runCommands } from './commands';

// -- fixture ------------------------------------------------------------------

// a tiny program: one verb with an option + a positional, plus a nested group
function fakeProgram(): Command {
    const program = new Command('uc').description('root');

    // a leaf verb carrying one option + one argument
    const add = new Command('add').description('add a thing');
    add.argument('<text>', 'the body').option('--role <role>', 'a role');
    program.addCommand(add as unknown as Command);

    // a group with a single nested subcommand
    const sync = new Command('sync').description('sync group');
    sync.addCommand(new Command('start').description('start it') as unknown as Command);
    program.addCommand(sync as unknown as Command);

    return program;
}

// -- serializer shape ---------------------------------------------------------

describe('serializeProgram', () => {
    // the root serializes to its own node with a recursive subcommands array
    it('serializes the root with name + description', () => {
        const tree = serializeProgram(fakeProgram());
        assert.equal(tree.name, 'uc');
        assert.equal(tree.description, 'root');
        assert.ok(Array.isArray(tree.subcommands));
    });

    // each verb carries its description, options, and positional arguments
    it('captures options + arguments for a leaf verb', () => {
        const tree = serializeProgram(fakeProgram());
        const add = tree.subcommands.find((c) => c.name === 'add');

        assert.ok(add, 'add is present');
        assert.equal(add!.description, 'add a thing');
        assert.ok(add!.options.some((o) => o.flags.includes('--role')), 'option flags captured');
        assert.ok(add!.arguments.some((a) => a.name === 'text'), 'positional captured');
    });

    // nested groups recurse — subcommands carry their own subcommands
    it('recurses into nested groups', () => {
        const tree = serializeProgram(fakeProgram());
        const sync = tree.subcommands.find((c) => c.name === 'sync');

        assert.ok(sync, 'sync group present');
        assert.equal(sync!.subcommands.length, 1);
        assert.equal(sync!.subcommands[0].name, 'start');
    });
});

// -- handler emits one json line ----------------------------------------------

describe('runCommands', () => {
    // the handler writes exactly one JSON line carrying the serialized tree
    it('emits one JSON line on stdout', () => {
        let stdout = '';
        const io = {
            stdout: { write: (s: string) => ((stdout += s), true) },
            stderr: { write: () => true },
            isTTY: false,
        };

        const code = runCommands(fakeProgram(), { json: true }, { io });
        assert.equal(code, 0);

        const lines = stdout.trim().split('\n');
        assert.equal(lines.length, 1);

        const out = JSON.parse(lines[0]);
        assert.equal(out.name, 'uc');
        assert.ok(out.subcommands.some((c: { name: string }) => c.name === 'sync'));
    });
});
