// =============================================================================
// delete — `uc delete <id...>`. ONE id keeps the original single-target rules
// (drop the whole context with --permanent, or specific messages with --ids).
// MULTIPLE ids switch to a BATCH permanent delete of whole contexts, which is
// always permanent → it REQUIRES an explicit --permanent (a bare multi-id delete
// errors), and --ids is refused as ambiguous. Client-agnostic: it talks to a
// ContextClient (local|remote) via lib/resolve-client. Pipe-aware output: data →
// stdout, errors → stderr; one JSON line in machine mode. Typo-safe: unknown
// flags abort. EXIT CODE: the batch exits 0 only when EVERY row deleted; ANY
// failed row exits 1 (rows + envelope still emitted) so a script can branch on
// the code while a human still sees which ids failed.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import type { ContextClient } from '../../../lib/context-client';
import { resolveClient } from '../../../lib/resolve-client';
import { requireContextId } from '../../../lib/context-id';
import { emit, outputError } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io + tty overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps the handler reads: client resolver, io sinks, and the --json toggle
type DeleteDeps = {
    resolveClient?: (opts?: { remote?: boolean }) => Promise<ContextClient>;
    io?: Io;
    json?: boolean;
};

// -- index/id parsing ---------------------------------------------------------

// an integer-looking token is a message index; anything else is a string id
function toTarget(token: string): string | number {
    return /^-?\d+$/.test(token) ? Number(token) : token;
}

// -- command factory ----------------------------------------------------------

// fold --meta key=val pairs into a metadata object (last write wins)
function parseMeta(pairs?: string[]): Record<string, unknown> | undefined {
    if (!pairs || pairs.length === 0) return undefined;

    const meta: Record<string, unknown> = {};
    for (const pair of pairs) {
        const eq = pair.indexOf('=');
        meta[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? true : pair.slice(eq + 1);
    }
    return meta;
}

// build the `delete` Command — variadic <id...>, --permanent, --ids, --meta.
// One id keeps the single-target rules; many ids → a batch permanent delete.
function buildCommand(): Command<[string[]]> {
    return new Command('delete')
        .alias('rm')
        .description('delete a context (or many), or messages')
        .argument('[ids...]', 'context id(s) (or set UC_CONTEXT for one)')
        .option('--permanent', 'permanently delete the whole context (required for batch)')
        .option('--ids <ids...>', 'delete only these message indices/ids (single target only)')
        .option('--meta <pair...>', 'metadata key=val (audit / version)');
}

// -- handler ------------------------------------------------------------------

// parse args, run the delete through the client, and resolve the exit code
export async function runDelete(args: string[], deps: DeleteDeps = {}): Promise<number> {
    // route the client resolver + io through injected deps (tests override them)
    const resolve = deps.resolveClient ?? resolveClient;
    const io = deps.io;
    const json = deps.json;

    // build a one-off command; exitOverride turns parse errors into throws,
    // and configureOutput pins Commander's own writes to the injected stderr
    const command = buildCommand().exitOverride();
    command.configureOutput({
        writeErr: (s) => void (io?.stderr ?? process.stderr).write(s),
        writeOut: (s) => void (io?.stderr ?? process.stderr).write(s),
    });

    try {
        // parse args only (no node/script prefix); typos throw here → exit 1
        command.parse(args, { from: 'user' });
        const opts = command.opts() as { permanent?: boolean; ids?: string[]; meta?: string[] };

        // the positional context id(s) — variadic, so 0, 1, or many
        const positionals = command.args as string[];

        // resolve the backing client (local sqlite by default)
        const client = await resolve();

        // --meta = version metadata on a message delete, audit metadata on a permanent one
        const metadata = parseMeta(opts.meta);

        // BATCH path — two+ positional ids → permanent delete of whole contexts.
        // It is always permanent, so it REQUIRES an explicit --permanent (a bare
        // multi-id delete errors) and --ids is refused as ambiguous (whole-context
        // vs message). Exit 0 only when EVERY row deleted; any failure → exit 1.
        if (positionals.length > 1) {
            if (opts.ids && opts.ids.length > 0) {
                throw new Error('cannot combine multiple context ids with --ids — --ids deletes messages from ONE context');
            }
            if (!opts.permanent) {
                throw new Error('batch delete is permanent — pass --permanent');
            }

            const result = await client.deleteMany({ ids: positionals, metadata });

            // human: one line per id (deleted / failed: reason) + a count summary
            emit(result, {
                json,
                human: (d) => {
                    const r = d as typeof result;
                    const rows = r.results.map((row) => (row.deleted ? `deleted ${row.id}` : `failed ${row.id}: ${row.error}`));
                    return [...rows, `deleted ${r.deleted_count}/${r.results.length}`].join('\n');
                },
            }, io);

            // exit 1 if ANY row failed (rows + envelope already emitted), else 0
            return result.deleted_count === result.results.length ? 0 : 1;
        }

        // SINGLE-target path — explicit id arg, else $UC_CONTEXT, else throw.
        // The env fallback only applies when ZERO positionals were given.
        const id = requireContextId(positionals[0]);

        // message-level delete — drop only the targeted indices/ids (versioned)
        if (opts.ids && opts.ids.length > 0) {
            const result = await client.delete({ id, ids: opts.ids.map(toTarget), metadata });
            emit(result, { json, human: () => `deleted messages from ${result.id}` }, io);
            return 0;
        }

        // GUARD: a bare delete (no --permanent, no --ids) is too destructive to be
        // the default — it would silently wipe the whole context. Require an
        // explicit intent flag instead.
        if (!opts.permanent) {
            throw new Error(
                'specify --permanent to delete the whole context, or --ids <...> to delete messages',
            );
        }

        // whole-context delete — remove the context permanently (with audit metadata)
        const result = await client.delete({ id, permanent: true, metadata });
        emit(result, { json, human: () => `deleted ${result.id}` }, io);
        return 0;
    } catch (error) {
        // failures (parse typos, missing context) → stderr envelope + exit code
        return outputError(error, { ...io, json });
    }
}

// -- arg reconstruction --------------------------------------------------------

// Commander consumes option tokens during the outer parse, so cmd.args holds
// ONLY positionals. runDelete re-parses from scratch, so we must rebuild the
// full token list (positional + flags) — otherwise --ids/--meta/--permanent are
// lost and a message delete silently becomes a permanent whole-context delete.
function reconstructArgs(
    positionals: string[],
    opts: { permanent?: boolean; ids?: string[]; meta?: string[] },
): string[] {
    const args = [...positionals];

    // --permanent is a boolean flag
    if (opts.permanent) args.push('--permanent');

    // --ids / --meta are variadic — re-emit each value after its flag
    if (opts.ids && opts.ids.length > 0) args.push('--ids', ...opts.ids);
    if (opts.meta && opts.meta.length > 0) args.push('--meta', ...opts.meta);

    return args;
}

// -- registration factory -----------------------------------------------------

// the Command registered on the program root — delegates to the handler
export function buildDeleteCommand(): Command {
    const command = buildCommand();

    // hand parsing back to runDelete so behavior matches the tested handler.
    // rebuild the full token list first — cmd.args drops consumed option tokens.
    command.action(async (_id, opts, cmd) => {
        const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
        const remote = Boolean((cmd.optsWithGlobals() as { remote?: boolean }).remote);
        const args = reconstructArgs(cmd.args, opts as { permanent?: boolean; ids?: string[]; meta?: string[] });
        const code = await runDelete(args, {
            resolveClient: () => resolveClient({ remote }),
            json,
        });

        // surface failures via exitCode (not process.exit, which races writes
        // AND would kill the host process under argv-level tests)
        process.exitCode = code;
    });

    return command as unknown as Command;
}
