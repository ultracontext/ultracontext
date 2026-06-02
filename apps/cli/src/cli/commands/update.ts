// =============================================================================
// update — `uc update` patches message(s) in a context (by id or index) with
// optional --meta. Local-first through the ContextClient; pipe-aware output.
// A Commander factory builds the verb; runUpdate is the testable handler.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { resolveClient } from '../../../lib/resolve-client';
import { requireContextId } from '../../../lib/context-id';
import { emit, outputError } from '../../../lib/output';

// -- io shape -----------------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// injectable io for tests; pipe-awareness keyed off isTTY
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// -- handler options ----------------------------------------------------------

// what to patch: a single message by id OR index, with new content + metadata.
// context targets the CONTEXT (the resolved positional id or $UC_CONTEXT);
// id/index target a MESSAGE within it.
export type UpdateOptions = {
    context?: string;
    id?: string;
    index?: number;
    content?: string;
    meta?: Record<string, unknown>;
    json?: boolean;
    remote?: boolean;
};

// run context: where to back the client + where to write
type UpdateContext = { dbUrl?: string; cwd?: string; remote?: boolean; io?: Io };

// -- handler ------------------------------------------------------------------

// patch the context's message(s), returning the process exit code
export async function runUpdate(opts: UpdateOptions, ctx: UpdateContext = {}): Promise<number> {
    const { io } = ctx;

    // reject an ambiguous selector before touching the store
    if (opts.id !== undefined && opts.index !== undefined) {
        return outputError(new Error('Cannot specify both id and index'), { ...io, json: opts.json });
    }

    try {
        // build the per-message patch from the selector + new content/metadata
        const patch: Record<string, unknown> = {};
        if (opts.id !== undefined) patch.id = opts.id;
        if (opts.index !== undefined) patch.index = opts.index;
        if (opts.content !== undefined) patch.content = opts.content;

        // resolve the target context — explicit --context, else $UC_CONTEXT, else throw
        const contextId = requireContextId(opts.context);

        // talk to the resolved backend (local sqlite by default)
        const client = await resolveClient({ remote: ctx.remote ?? opts.remote, dbUrl: ctx.dbUrl, cwd: ctx.cwd });
        const result = await client.update({ id: contextId, updates: [patch], metadata: opts.meta });

        // data → stdout: the updated views + the new version
        emit(result, { json: opts.json }, io);
        return 0;
    } catch (error) {
        // failure → stderr envelope, no data line
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- command factory ----------------------------------------------------------

// `uc update` — collect --id/--index/--content/--meta, then run the handler
export function buildUpdateCommand(): Command {
    const command = new Command('update');

    // collect repeated --meta key=val pairs into one object
    const collectMeta = (pair: string, acc: Record<string, unknown>) => {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        acc[key] = eq === -1 ? true : pair.slice(eq + 1);
        return acc;
    };

    command
        .description('update messages in a context')
        .argument('[id]', 'target context id (or set UC_CONTEXT)')
        .option('--id <id>', 'target message by id')
        .option('--index <n>', 'target message by index', (v) => Number.parseInt(v, 10))
        .option('--content <text>', 'new message content')
        .option('--meta <key=val>', 'attach version metadata (repeatable)', collectMeta, {})
        // no local --json (the root global covers it) and no --context flag —
        // the positional id + $UC_CONTEXT is uniform across the targeted verbs
        .action(async (id, opts, cmd) => {
            // merge in the global --json/--remote flags off the program root
            const globals = cmd.optsWithGlobals() as { json?: boolean; remote?: boolean };

            // the positional id falls back to $UC_CONTEXT inside the handler
            const code = await runUpdate({
                ...opts,
                context: id,
                json: globals.json,
                remote: globals.remote,
            });

            // surface failures via exitCode (not process.exit, which races writes)
            process.exitCode = code;
        });

    return command as unknown as Command;
}
