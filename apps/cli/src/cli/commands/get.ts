// =============================================================================
// get — the `uc get` verb. Reads a context local-first through a ContextClient:
// the cwd default context, or an explicit --context <id>, optionally at a past
// --version/--at/--before or with --history. Data → stdout, errors → stderr.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import type { ContextClient, GetResult } from '../../../lib/context-client';
import { resolveClient } from '../../../lib/resolve-client';
import { emit, outputError } from '../../../lib/output';

// -- io types -----------------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// injected io for output helpers (overridable so the json/human split is testable)
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// -- options ------------------------------------------------------------------

// command options: target selection + version-control selectors + output mode
export type GetOptions = {
    context?: string;
    version?: number;
    at?: number;
    before?: string;
    history?: boolean;
    json?: boolean;
};

// run context: which store to read + where to write (all injectable for tests)
export type GetContext = { dbUrl?: string; cwd?: string; remote?: boolean; io?: Io };

// -- human formatter ----------------------------------------------------------

// render the read messages as one line per message (role: content)
function humanGet(result: GetResult): string {
    return result.data
        .map((m) => `${String(m.role ?? '')}: ${String(m.content ?? '')}`.trim())
        .join('\n');
}

// -- handler ------------------------------------------------------------------

// read the resolved context and emit it; return the process exit code (0 | 1 | 130)
export async function runGet(opts: GetOptions, ctx: GetContext = {}): Promise<number> {
    const io = ctx.io;

    try {
        // resolve the backing client (local sqlite by default, remote when asked)
        const client: ContextClient = await resolveClient({
            remote: ctx.remote,
            dbUrl: ctx.dbUrl,
            cwd: ctx.cwd,
        });

        // read the target context — explicit id, else the cwd default
        const result = await client.get({
            id: opts.context,
            version: opts.version,
            at: opts.at,
            before: opts.before,
            history: opts.history,
        });

        // data → stdout (JSON envelope in machine mode, lines in human mode)
        emit(result, { json: opts.json, human: (d) => humanGet(d as GetResult) }, io);
        return 0;
    } catch (error) {
        // failure → stderr, exit 1 (130 on user cancel)
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- commander factory --------------------------------------------------------

// build the `get` command and wire its action to the handler
export function buildGetCommand(): Command {
    const command = new Command('get');

    // describe the verb + its selectors
    command
        .description('read a context')
        .option('--context <id>', 'read an explicit context id (else the cwd default)')
        .option('--version <n>', 'read a specific version', (v) => parseInt(v, 10))
        .option('--at <index>', 'read at a message index', (v) => parseInt(v, 10))
        .option('--before <timestamp>', 'read the version before a timestamp')
        .option('--history', 'include the version history');

    // parse globals + locals, then run the handler and exit with its code
    command.action(async (opts, cmd) => {
        const globals = cmd.optsWithGlobals() as { json?: boolean; remote?: boolean };
        const code = await runGet(
            { ...opts, json: globals.json },
            { remote: globals.remote },
        );
        process.exitCode = code;
    });

    return command;
}
