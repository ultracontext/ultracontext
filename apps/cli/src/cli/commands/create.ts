// =============================================================================
// create — `uc create`. Makes a NEW context, or FORKS from --from (optionally at
// a past --version/--at/--before) — mirroring the SDK's create({from}). --meta
// key=val tags the CONTEXT itself. Prints the new id: a JSON envelope in machine
// mode, the bare id in human mode (so `id=$(uc create)` works in a shell).
// Local-first through the ContextClient. Data → stdout, errors → stderr.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { resolveClient } from '../../../lib/resolve-client';
import { emit, outputError } from '../../../lib/output';

// -- io types -----------------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// injected io for the output helpers (overridable so the json/human split tests)
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// -- options ------------------------------------------------------------------

// command options: an optional fork source + its version selectors + context
// metadata + the output mode. No id is targeted — create MINTS one.
export type CreateOptions = {
    from?: string;
    version?: number;
    at?: number;
    before?: string;
    meta?: Record<string, unknown>;
    json?: boolean;
    remote?: boolean;
};

// run context: which store to write + where to write (all injectable for tests)
export type CreateContext = { dbUrl?: string; cwd?: string; remote?: boolean; io?: Io };

// -- handler ------------------------------------------------------------------

// create (or fork) a context, then emit its id; return the process exit code
export async function runCreate(opts: CreateOptions, ctx: CreateContext = {}): Promise<number> {
    const io = ctx.io;

    try {
        // resolve the backing client (local sqlite by default, remote when asked)
        const client = await resolveClient({ remote: ctx.remote ?? opts.remote, dbUrl: ctx.dbUrl, cwd: ctx.cwd });

        // mint a new context, or FORK from --from at the selected version/index.
        // --meta rides through as CONTEXT metadata.
        const result = await client.create({
            from: opts.from,
            version: opts.version,
            at: opts.at,
            before: opts.before,
            metadata: opts.meta,
        });

        // data → stdout: the full envelope in machine mode, the bare id in human
        emit(result, { json: opts.json, human: (d) => (d as { id: string }).id }, io);
        return 0;
    } catch (error) {
        // failure → stderr, exit 1 (130 on user cancel)
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- command factory ----------------------------------------------------------

// `uc create` — collect --from/--version/--at/--before/--meta, then run the handler
export function buildCreateCommand(): Command {
    const command = new Command('create');

    // collect repeated --meta key=val pairs into one object (context metadata)
    const collectMeta = (pair: string, acc: Record<string, unknown>) => {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        acc[key] = eq === -1 ? true : pair.slice(eq + 1);
        return acc;
    };

    command
        .description('create a context (or fork/clone from an existing one)')
        .option('--from <id>', 'fork/clone from an existing context id')
        .option('--version <n>', 'fork at a specific version', (v) => Number.parseInt(v, 10))
        .option('--at <index>', 'fork at a message index', (v) => Number.parseInt(v, 10))
        .option('--before <timestamp>', 'fork at the version before a timestamp')
        .option('--meta <key=val>', 'attach context metadata (repeatable)', collectMeta, {})
        .action(async (opts, cmd) => {
            // fold the global --json/--remote off the program root into the options
            const globals = cmd.optsWithGlobals() as { json?: boolean; remote?: boolean };

            // run the handler; surface failures via process.exitCode
            process.exitCode = await runCreate({ ...opts, json: globals.json, remote: globals.remote });
        });

    return command as unknown as Command;
}
