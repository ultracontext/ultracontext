// =============================================================================
// append — `uc append <id>` quick-capture. Append message(s) to an EXPLICIT
// context: the id is a required positional, resolved via requireContextId so
// $UC_CONTEXT works as a fallback. There is NO default context. Body sources:
// positional text | stdin | --json full object. Flags: --role, --meta (MESSAGE
// metadata). Local-first through the resolved ContextClient (UC_DB_URL).
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { resolveClient } from '../../../lib/resolve-client';
import { requireContextId } from '../../../lib/context-id';
import { emit, outputError, shouldJson } from '../../../lib/output';
import type { Message } from '../../../lib/context-client';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io + stdin + exit + env injected by tests; real process bindings are defaults
type Runtime = {
    io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean };
    stdin?: AsyncIterable<string>;
    exit?: (code?: number) => void;
    env?: Record<string, string | undefined>;
};

// -- parsed options -----------------------------------------------------------

// commander-collected flags for the verb (--meta tags the MESSAGE)
type AppendOptions = {
    role?: string;
    meta?: string[];
    json?: string | boolean;
    remote?: boolean;
};

// -- stdin read ---------------------------------------------------------------

// drain an async-iterable stdin into a single trimmed string (empty when none)
async function readStdin(stdin?: AsyncIterable<string>): Promise<string> {
    if (!stdin) return '';

    let body = '';
    for await (const chunk of stdin) body += chunk;
    return body.trim();
}

// -- metadata parse -----------------------------------------------------------

// fold --meta key=val pairs into a metadata object (last write wins)
function parseMeta(pairs?: string[]): Record<string, unknown> {
    const meta: Record<string, unknown> = {};

    for (const pair of pairs ?? []) {
        const eq = pair.indexOf('=');
        if (eq === -1) throw new Error(`invalid --meta "${pair}" (expected key=val)`);
        meta[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    return meta;
}

// -- message build ------------------------------------------------------------

// resolve the message body from the available sources, newest precedence first:
// a raw --json <body> object, else positional/stdin text wrapped as content.
async function buildMessage(
    text: string | undefined,
    opts: AppendOptions,
    stdin?: AsyncIterable<string>,
): Promise<Message> {
    // --json <body> carries a full message object (role/content/metadata)
    if (typeof opts.json === 'string') {
        const parsed = JSON.parse(opts.json) as Record<string, unknown>;
        return parsed as Message;
    }

    // otherwise the body is positional text, falling back to piped stdin
    const content = text ?? (await readStdin(stdin));
    if (!content) throw new Error('nothing to capture (pass text, pipe stdin, or use --json)');

    // assemble content + optional role + --meta MESSAGE metadata
    const message: Message = { content };
    if (opts.role) message.role = opts.role;

    const metadata = parseMeta(opts.meta);
    if (Object.keys(metadata).length > 0) message.metadata = metadata;

    return message;
}

// -- positional resolution ----------------------------------------------------

// reconcile the two positionals against $UC_CONTEXT. When the env supplies a
// context AND only ONE positional was given (id present, text absent), that lone
// positional is the message TEXT — the id comes from the env. This lets
// `UC_CONTEXT=x uc append "note"` work while `uc append <id> <text>` is intact.
function resolvePositionals(
    id: string | undefined,
    text: string | undefined,
    env: Record<string, string | undefined>,
): { id: string | undefined; text: string | undefined } {
    if (env.UC_CONTEXT && id !== undefined && text === undefined) {
        return { id: undefined, text: id };
    }
    return { id, text };
}

// -- handler ------------------------------------------------------------------

// resolve the target id, append through the client, emit the appended view + id
export async function runAppend(
    idArg: string | undefined,
    textArg: string | undefined,
    opts: AppendOptions,
    runtime: Runtime,
): Promise<number> {
    const io = runtime.io;
    const env = runtime.env ?? process.env;
    const json = shouldJson({ json: Boolean(opts.json) }, io);

    try {
        // env-aware: a lone positional is TEXT when $UC_CONTEXT supplies the id
        const { id, text } = resolvePositionals(idArg, textArg, env);

        // target an explicit <id> positional, else $UC_CONTEXT, else a clear error
        const contextId = requireContextId(id, env);

        // assemble the message before touching storage so bad input fails fast
        const message = await buildMessage(text, opts, runtime.stdin);

        // resolve the backing client (local sqlite by default)
        const client = await resolveClient({ remote: opts.remote });

        // append the message to the resolved context id
        const result = await client.append({ id: contextId, messages: [message] });

        // the resolved context id rides along the envelope for agents to chain on
        const view = { data: result.data, version: result.version, id: result.id };

        // data → stdout; one JSON line in machine mode, a short line otherwise
        emit(view, { json, human: (d) => `appended (v${(d as typeof view).version})` }, io);
        return 0;
    } catch (error) {
        // failure → stderr only, non-zero exit (no data on stdout)
        return outputError(error, { ...io, json });
    }
}

// -- command factory ----------------------------------------------------------

// build the `uc append` Command, wiring its action to the injectable handler
export function buildAppendCommand(runtime: Runtime = {}): Command {
    const command = new Command('append');

    // quick-capture surface: required id positional + body + role/meta flags
    command
        .description('append a message to a context')
        .argument('[id]', 'target context id (or set UC_CONTEXT)')
        .argument('[text]', 'message body (omit to read stdin)')
        .option('--role <role>', 'message role (e.g. user, assistant)')
        .option('--meta <pair...>', 'message metadata key=val (repeatable)')
        .option('--json [body]', 'machine output, or parse a raw message object')
        .action(async (id, text, opts, cmd) => {
            // fold the global --remote off the program root into the verb options
            const remote = Boolean((cmd.optsWithGlobals() as { remote?: boolean }).remote);

            // run the handler and route its exit code through the injected exit
            const code = await runAppend(id, text, { ...(opts as AppendOptions), remote }, runtime);
            if (code !== 0) (runtime.exit ?? process.exit)(code);
            else runtime.exit?.(0);
        });

    return command;
}
