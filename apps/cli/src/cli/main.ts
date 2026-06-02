// =============================================================================
// main — the `uc` Commander program root. Registers context verbs + command
// groups as stubs for now. Global --json/--remote wired to the output helper.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { emit, status } from '../../lib/output';

// -- stub action --------------------------------------------------------------

// read the global --json flag off any command (extra-typings can't infer it)
function jsonFlag(cmd: Command): boolean {
    return Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
}

// every command currently reports "not implemented" via the pipe-aware emit
function stub(name: string) {
    return (_opts: unknown, cmd: Command) => {
        emit({ command: name, status: 'not_implemented' }, { json: jsonFlag(cmd), human: () => `${name}: not implemented` });
    };
}

// -- context verbs ------------------------------------------------------------

// top-level add/get/update/delete/list talk to a ContextClient (local | remote)
function registerContextVerbs(program: Command): void {
    program.command('add').description('append messages to a context').action(stub('add'));
    program.command('get').description('read a context').action(stub('get'));
    program.command('update').description('update messages in a context').action(stub('update'));
    program.command('delete').description('delete a context or messages').action(stub('delete'));
    program.command('list').description('list contexts').action(stub('list'));
}

// -- sync group ---------------------------------------------------------------

// `uc sync <init|start|stop|status|source|event>` → @ultracontext/sync
function registerSync(program: Command): void {
    const sync = program.command('sync').description('fs-first sync orchestration');

    for (const sub of ['init', 'start', 'stop', 'status', 'source', 'event']) {
        sync.command(sub).description(`sync ${sub}`).action(stub(`sync ${sub}`));
    }
}

// -- standalone groups --------------------------------------------------------

// self-update, environment doctor, project init
function registerStandalone(program: Command): void {
    program.command('upgrade').description('self-update the uc CLI').action(stub('upgrade'));
    program.command('doctor').description('diagnose the local environment').action(stub('doctor'));
    program.command('init').description('initialize ultracontext for this project').action(stub('init'));
}

// -- commands (machine-readable tree) -----------------------------------------

// `uc commands --json` → the full command tree for agents to introspect
function registerCommands(program: Command): void {
    program
        .command('commands')
        .description('print the command tree (machine-readable with --json)')
        .action((_opts, cmd) => {
            // serialize each registered command into a flat tree
            const tree = program.commands.map((c) => ({
                name: c.name(),
                description: c.description(),
                subcommands: c.commands.map((s) => s.name()),
            }));

            emit({ commands: tree }, { json: jsonFlag(cmd), human: () => tree.map((c) => c.name).join('\n') });
        });
}

// -- program factory ----------------------------------------------------------

// build the root program with global options + every command group
export function buildProgram(): Command {
    const program = new Command();

    // root metadata
    program
        .name('uc')
        .description('UltraContext — version control for AI agent context')
        .version('1.5.0');

    // global options consumed by the output helper + client resolver
    program.option('--json', 'emit machine-readable JSON');
    program.option('--remote', 'talk to the hosted API instead of local storage');

    // register every command group
    registerContextVerbs(program);
    registerSync(program);
    registerStandalone(program);
    registerCommands(program);

    return program;
}

// -- runner -------------------------------------------------------------------

// parse argv; exit 130 on user cancel (clack), 1 on any other error
export async function run(argv: string[] = process.argv): Promise<void> {
    const program = buildProgram();

    try {
        await program.parseAsync(argv);
    } catch (err) {
        // clack cancellation surfaces as a thrown symbol/marker
        if (err && (err as { code?: string }).code === 'cancel') {
            status('cancelled');
            process.exit(130);
        }

        process.stderr.write(String((err as Error)?.message ?? err) + '\n');
        process.exit(1);
    }
}
