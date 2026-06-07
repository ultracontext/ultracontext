// =============================================================================
// main — the `uc` Commander program root. Registers the context verbs, the
// mirror group, the remote group (the one central machine), the utility commands
// (doctor/init/upgrade/commands), and the global --json/--remote flags consumed
// by the output helper + client resolver.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { status } from '../../lib/output';
import { VERSION } from '../../lib/version';
import { buildCreateCommand } from './commands/create';
import { buildAppendCommand } from './commands/append';
import { buildGetCommand } from './commands/get';
import { buildUpdateCommand } from './commands/update';
import { registerList } from './commands/list';
import { buildDeleteCommand } from './commands/delete';
import { buildEventCommand } from './commands/event';
import { buildDriverCommand } from './commands/driver';
import { buildMirrorCommand } from './commands/mirror';
import { buildRemoteCommand } from './commands/remote';
import { buildServeCommand } from './commands/serve';
import { buildDoctorCommand } from './commands/doctor';
import { buildInitCommand } from './commands/init';
import { buildUpgradeCommand } from './commands/upgrade';
import { buildCommandsCommand } from './commands/commands';
import { buildVersionCommand } from './commands/version';

// -- context group ------------------------------------------------------------

// `uc context <create|append|get|update|delete|list>` (alias `ctx`) talk to a
// ContextClient (local | remote). The PRIMITIVE is explicit — `uc context append`
// answers "append WHERE" — matching the grouped event/driver/mirror/remote domains.
// The verb names mirror the SDK methods; every targeted verb takes an EXPLICIT
// context id — there is no default context.
function registerContextVerbs(program: Command): void {
    const context = new Command('context')
        .alias('ctx')
        .description('manage versioned contexts (the store)');

    context.addCommand(buildCreateCommand());
    context.addCommand(buildAppendCommand());
    context.addCommand(buildGetCommand());
    context.addCommand(buildUpdateCommand());
    context.addCommand(buildDeleteCommand());
    registerList(context);

    program.addCommand(context);
}

// -- event group --------------------------------------------------------------

// top-level `uc event <emit|tail|status|flush|commit>` → @ultracontext/core
// event ops over the local EventStore + a pluggable (ssh) transport.
function registerEvent(program: Command): void {
    program.addCommand(buildEventCommand());
}

// -- driver group -------------------------------------------------------------

// top-level `uc driver <list|run>` → the manifest reader + the sh-c runner. A
// driver is the side-effect boundary: `run` executes its command as a local
// process on this host, streaming stdio through and propagating the exit code.
function registerDriver(program: Command): void {
    program.addCommand(buildDriverCommand());
}

// -- mirror group -------------------------------------------------------------

// `uc mirror <start|stop|status|source|list|reset>` → @ultracontext/mirror
function registerMirror(program: Command): void {
    program.addCommand(buildMirrorCommand());
}

// -- remote group -------------------------------------------------------------

// top-level `uc remote <set|show|test|clear>` → the ONE central machine the
// CLI routes to: the ssh side (mirror + event transport) + the api side
// (contexts/events over HTTP). The single writer of the unified config.json view.
function registerRemote(program: Command): void {
    program.addCommand(buildRemoteCommand());
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
    program.addCommand(buildServeCommand());
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
        .description('UltraContext — the context toolkit for AI agents');

    // global options consumed by the output helper + client resolver
    program.option('--json', 'emit machine-readable JSON');
    program.option('--remote', 'talk to the hosted API instead of local storage');

    // register every command group (commands last — it walks the whole tree)
    registerContextVerbs(program);
    registerEvent(program);
    registerDriver(program);
    registerMirror(program);
    registerRemote(program);
    registerStandalone(program);
    registerCommands(program);

    return program;
}

// -- runner -------------------------------------------------------------------

// a minimal stdout sink — the real process.stdout satisfies it (tests inject one)
type Out = { write(s: string): boolean };

// root `uc --version` / `-V`: handled HERE, before Commander, so it never becomes
// a global option that shadows the `get/create --version <n>` time-travel selector.
// Only the LEADING token (after the global --json/--remote flags) counts — so
// `uc --version` matches but `uc get --version 0` (leading token = `get`) does not.
// Exported for a pure unit test (no IO/backend).
export function handleRootVersion(args: string[], out: Out): boolean {
    const lead = args.find((a) => a !== '--json' && a !== '--remote');
    if (lead !== '--version' && lead !== '-V') return false;

    // mirror `uc version`: bare line in human mode, an envelope under --json
    out.write(args.includes('--json') ? `${JSON.stringify({ version: VERSION })}\n` : `${VERSION}\n`);
    return true;
}

// the leading non-flag token is an unknown top-level command (not a known name
// or alias, and not a help/version request) → Commander's help-on-unknown path
// swallows it to exit 0; reject it ourselves so it exits non-zero. Exported pure.
export function unknownLeadingCommand(args: string[], program: Command): string | undefined {
    const lead = args.find((a) => !a.startsWith('-'));
    if (!lead) return undefined;

    // Commander's implicit `help` command never appears in program.commands
    const known = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
    known.add('help');

    return known.has(lead) ? undefined : lead;
}

// parse argv; exit 130 on user cancel (clack), 1 on any other error
export async function run(argv: string[] = process.argv, io: { stdout?: Out } = {}): Promise<void> {
    // short-circuit the root version flag before Commander sees argv
    if (handleRootVersion(argv.slice(2), io.stdout ?? process.stdout)) return;

    const program = buildProgram();

    // reject an unknown leading command before Commander's help path exits 0
    const unknown = unknownLeadingCommand(argv.slice(2), program);
    if (unknown) {
        process.stderr.write(`error: unknown command '${unknown}'\n`);
        process.exit(1);
    }

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
