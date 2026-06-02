// =============================================================================
// commands — `uc commands --json`. Walk the live Commander tree and emit it as
// a recursive machine-readable JSON tree (name/description/options/arguments/
// subcommands) so agents can introspect the full surface. Pipe-aware via emit.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { emit } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Runtime = { io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean } };

// -- serialized shape ---------------------------------------------------------

// one option as the agent sees it. Commander has TWO distinct "required"
// notions, so we surface both: valueRequired = the flag takes a value when
// present (<v> not [v]); mandatory = the flag itself must be supplied.
type OptionNode = { flags: string; description: string; valueRequired: boolean; mandatory: boolean };

// one positional argument: its name + description + required/variadic markers
type ArgNode = { name: string; description: string; required: boolean; variadic: boolean };

// a command node, recursive through its subcommands
export type CommandNode = {
    name: string;
    description: string;
    options: OptionNode[];
    arguments: ArgNode[];
    subcommands: CommandNode[];
};

// -- serializer ---------------------------------------------------------------

// project a command's options into flat nodes, splitting the two "required"
// notions so agents don't misread an optional flag as mandatory
function serializeOptions(cmd: Command): OptionNode[] {
    return cmd.options.map((o) => ({
        flags: o.flags,
        description: o.description ?? '',
        // o.required = the value is required when the flag is present (<v>)
        valueRequired: Boolean(o.required),
        // o.mandatory = the flag itself must be supplied (requiredOption)
        mandatory: Boolean(o.mandatory),
    }));
}

// project a command's positionals into flat arg nodes (name/required/variadic)
function serializeArgs(cmd: Command): ArgNode[] {
    return cmd.registeredArguments.map((a) => ({
        name: a.name(),
        description: a.description ?? '',
        required: a.required,
        variadic: a.variadic,
    }));
}

// serialize one command + recurse into its subcommands
export function serializeProgram(cmd: Command): CommandNode {
    return {
        name: cmd.name(),
        description: cmd.description() ?? '',
        options: serializeOptions(cmd),
        arguments: serializeArgs(cmd),
        subcommands: cmd.commands.map((c) => serializeProgram(c as unknown as Command)),
    };
}

// -- handler ------------------------------------------------------------------

// serialize the program and emit it as one JSON line (always machine-shaped)
export function runCommands(program: Command, opts: { json?: boolean }, runtime: Runtime = {}): number {
    const tree = serializeProgram(program);

    // the tree is structural data → stdout; human mode prints the same JSON
    emit(tree, { json: opts.json, human: (d) => JSON.stringify(d, null, 2) }, runtime.io);
    return 0;
}

// -- command factory ----------------------------------------------------------

// build the `commands` verb, closing over the program so it can walk the tree
export function buildCommandsCommand(program: Command): Command {
    const command = new Command('commands');

    // print the full command tree (machine-readable with --json)
    command
        .description('print the command tree (machine-readable with --json)')
        .action((_opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
            process.exitCode = runCommands(program, { json });
        });

    return command;
}
