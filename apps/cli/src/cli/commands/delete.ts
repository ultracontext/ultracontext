// =============================================================================
// delete — `uc delete <id>`. Drops a whole context (--permanent) or specific
// messages (--ids). Client-agnostic: it talks to a ContextClient (local|remote)
// resolved via lib/resolve-client. Pipe-aware output: data → stdout, errors →
// stderr; one JSON line in machine mode. Typo-safe: unknown flags abort.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import type { ContextClient, DeleteInput } from '../../../lib/context-client';
import { resolveClient } from '../../../lib/resolve-client';
import { emit, outputError } from '../../../lib/output';

// -- delete input -------------------------------------------------------------

// the verb also carries message-level targets; the client routes ids → message
// delete, else a whole-context (permanent) delete
type DeleteArgs = DeleteInput & { ids?: (string | number)[] };

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

// build the `delete` Command — positional <id>, --permanent, --ids <indices...>
function buildCommand(): Command<[string | undefined]> {
    return new Command('delete')
        .alias('rm')
        .description('delete a context or messages')
        .argument('[id]', 'context id (defaults to the cwd context)')
        .option('--permanent', 'permanently delete the whole context')
        .option('--ids <ids...>', 'delete only these message indices/ids');
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
        const opts = command.opts() as { permanent?: boolean; ids?: string[] };
        const id = command.args[0];

        // resolve the backing client (local sqlite by default)
        const client = await resolve();

        // message-level delete — drop only the targeted indices/ids
        if (opts.ids && opts.ids.length > 0) {
            const args: DeleteArgs = { id, ids: opts.ids.map(toTarget) };
            const result = await client.delete(args);
            emit(result, { json, human: () => `deleted messages from ${result.id}` }, io);
            return 0;
        }

        // whole-context delete — remove the context permanently
        const result = await client.delete({ id, permanent: true });
        emit(result, { json, human: () => `deleted ${result.id}` }, io);
        return 0;
    } catch (error) {
        // failures (parse typos, missing context) → stderr envelope + exit code
        return outputError(error, { ...io, json });
    }
}

// -- registration factory -----------------------------------------------------

// the Command registered on the program root — delegates to the handler
export function buildDeleteCommand(): Command {
    const command = buildCommand();

    // hand parsing back to runDelete so behavior matches the tested handler
    command.action(async (_id, _opts, cmd) => {
        const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
        const remote = Boolean((cmd.optsWithGlobals() as { remote?: boolean }).remote);
        const code = await runDelete(cmd.args, {
            resolveClient: () => resolveClient({ remote }),
            json,
        });
        if (code !== 0) process.exit(code);
    });

    return command as unknown as Command;
}
