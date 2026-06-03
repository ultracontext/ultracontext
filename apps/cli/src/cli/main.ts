// =============================================================================
// main — the `uc` Commander program root. Registers the context verbs, the sync
// group, the utility commands (doctor/init/upgrade/commands), and the global
// --json/--remote flags consumed by the output helper + client resolver.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { status } from '../../lib/output';
import { buildCreateCommand } from './commands/create';
import { buildAppendCommand } from './commands/append';
import { buildGetCommand } from './commands/get';
import { buildUpdateCommand } from './commands/update';
import { registerList } from './commands/list';
import { buildDeleteCommand } from './commands/delete';
import { buildEventCommand } from './commands/event';
import { buildSyncCommand } from './commands/sync';
import { buildDoctorCommand } from './commands/doctor';
import { buildInitCommand } from './commands/init';
import { buildUpgradeCommand } from './commands/upgrade';
import { buildCommandsCommand } from './commands/commands';
import { buildVersionCommand } from './commands/version';

// -- context verbs ------------------------------------------------------------

// top-level create/append/get/update/delete/list talk to a ContextClient
// (local | remote). The verb names mirror the SDK; every targeted verb takes an
// EXPLICIT context id — there is no default context.
function registerContextVerbs(program: Command): void {
    program.addCommand(buildCreateCommand());
    program.addCommand(buildAppendCommand());
    program.addCommand(buildGetCommand());
    program.addCommand(buildUpdateCommand());
    program.addCommand(buildDeleteCommand());
    registerList(program);
}

// -- event group --------------------------------------------------------------

// top-level `uc event <emit|tail|status|flush|commit>` → @ultracontext/core
// event ops over the local EventStore + a pluggable (ssh) transport.
function registerEvent(program: Command): void {
    program.addCommand(buildEventCommand());
}

// -- sync group ---------------------------------------------------------------

// `uc sync <init|start|stop|status|source|list>` → @ultracontext/sync
function registerSync(program: Command): void {
    program.addCommand(buildSyncCommand());
}

// -- standalone groups --------------------------------------------------------

// self-update, environment doctor, project init, tool version.
// version is a SUBCOMMAND (`uc version`), NOT Commander's global --version flag:
// a global --version is inherited by subcommands and would shadow the
// `--version <n>` time-travel selector on get/create.
function registerStandalone(program: Command): void {
    program.addCommand(buildUpgradeCommand());
    program.addCommand(buildDoctorCommand());
    program.addCommand(buildInitCommand());
    program.addCommand(buildVersionCommand());
}

// -- commands (machine-readable tree) -----------------------------------------

// `uc commands --json` → the full command tree for agents to introspect.
// registered last so the serializer walks a fully-populated program.
function registerCommands(program: Command): void {
    program.addCommand(buildCommandsCommand(program));
}

// -- program factory ----------------------------------------------------------

// build the root program with global options + every command group
export function buildProgram(): Command {
    const program = new Command();

    // root metadata. NO .version() — a global --version flag is inherited by
    // subcommands and shadows the `--version <n>` time-travel selector. The tool
    // version lives behind `uc version` / `uc doctor` instead.
    program
        .name('uc')
        .description('UltraContext — version control for AI agent context');

    // global options consumed by the output helper + client resolver
    program.option('--json', 'emit machine-readable JSON');
    program.option('--remote', 'talk to the hosted API instead of local storage');

    // register every command group (commands last — it walks the whole tree)
    registerContextVerbs(program);
    registerEvent(program);
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
