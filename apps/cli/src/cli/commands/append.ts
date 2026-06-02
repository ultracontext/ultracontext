// =============================================================================
// append — `uc append <id> [text]` quick-capture. Append message(s) to an
// EXPLICIT context. positional[0] is ALWAYS the context id (falls back to
// $UC_CONTEXT when omitted); positional[1] is the message text. Body sources:
// positional text | stdin | --json full object — when the id comes from
// $UC_CONTEXT the body MUST come from stdin/--json (NOT a lone positional, which
// would otherwise be misread as text). Flags: --role, --meta (MESSAGE metadata,
// merged even onto a --json body). Local-first through the ContextClient.
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

// commander-collected flags for the verb. --message carries a raw JSON message
// object (role/content/metadata); --meta tags the MESSAGE; --json is the global
// machine-output toggle off the root (NOT a body source — that overloaded the
// flag and let the root's boolean --json swallow the object as positional text).
type AppendOptions = {
    role?: string;
    meta?: string[];
    message?: string;
    json?: boolean;
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

// -- json-object detection ----------------------------------------------------

// parse a string as a JSON OBJECT, or return undefined when it is not one
// (a primitive, an array, or invalid JSON all stay undefined → plain text)
function parseJsonObject(text: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(text);
        const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        return isObject ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

// -- message build ------------------------------------------------------------

// resolve the message body from the available sources, newest precedence first:
// a raw --message <json> object; else, when the global --json is set, a positional
// that IS a JSON object (the `append <id> --json '{...}'` shorthand the global
// boolean would otherwise swallow into raw text); else positional/stdin text
// wrapped as content. --meta MESSAGE metadata is merged in regardless of source.
async function buildMessage(
    text: string | undefined,
    opts: AppendOptions,
    stdin?: AsyncIterable<string>,
): Promise<Message> {
    const metadata = parseMeta(opts.meta);

    // merge --meta onto a message's own metadata (flag wins on key collision)
    const withMeta = (message: Message): Message => {
        if (Object.keys(metadata).length > 0) {
            message.metadata = { ...(message.metadata ?? {}), ...metadata };
        }
        return message;
    };

    // --message <json> carries a full message object (role/content/metadata).
    if (typeof opts.message === 'string') {
        return withMeta(JSON.parse(opts.message) as Message);
    }

    // `append <id> --json '{...}'`: the global boolean --json can't carry a value
    // (Commander routes it to the root), so the object lands as the positional.
    // Under an explicit --json, a JSON-OBJECT positional is a structured message
    // — parse it (instead of silently storing the raw JSON string). A non-object
    // positional (plain string) falls through to the text path unchanged.
    if (opts.json && typeof text === 'string') {
        const object = parseJsonObject(text);
        if (object) return withMeta(object as Message);
    }

    // otherwise the body is positional text, falling back to piped stdin
    const content = text ?? (await readStdin(stdin));
    if (!content) throw new Error('nothing to capture (pass text, pipe stdin, or use --message)');

    // assemble content + optional role + --meta MESSAGE metadata
    const message: Message = { content };
    if (opts.role) message.role = opts.role;

    return withMeta(message);
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
        // positional[0] is ALWAYS the context id, positional[1] is the text — no
        // "lone positional becomes text" magic (that silently wrote a target id
        // as a message body into $UC_CONTEXT). When the id positional is omitted
        // it falls back to $UC_CONTEXT, and the body MUST come from stdin/--message.
        const contextId = requireContextId(idArg, env);

        // assemble the message before touching storage so bad input fails fast
        const message = await buildMessage(textArg, opts, runtime.stdin);

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

// -- stdin adapter ------------------------------------------------------------

// the live process.stdin as an async-iterable of strings — only when it is a
// real pipe (NOT a tty), so an interactive run never blocks waiting on input.
function processStdin(): AsyncIterable<string> | undefined {
    if (process.stdin.isTTY) return undefined;
    process.stdin.setEncoding('utf8');
    return process.stdin as unknown as AsyncIterable<string>;
}

// -- command factory ----------------------------------------------------------

// build the `uc append` Command, wiring its action to the injectable handler.
// stdin defaults to the live process.stdin so `echo body | uc append <id>`
// works in the real binary (tests inject a fake stdin instead).
export function buildAppendCommand(runtime: Runtime = {}): Command {
    const command = new Command('append');

    // quick-capture surface: id positional + text positional + body/role/meta
    // flags. --json is the GLOBAL machine-output toggle (off the root) — a raw
    // message object goes through --message so the boolean --json never swallows
    // it as positional text.
    command
        .description('append a message to a context')
        .argument('[id]', 'target context id (or set UC_CONTEXT)')
        .argument('[text]', 'message body (omit to read stdin)')
        .option('--role <role>', 'message role (e.g. user, assistant)')
        .option('--meta <pair...>', 'message metadata key=val (repeatable)')
        .option('--message <json>', 'parse a raw JSON message object (role/content/metadata)')
        .action(async (id, text, opts, cmd) => {
            // fold the global --json/--remote off the program root into the options
            const globals = cmd.optsWithGlobals() as { json?: boolean; remote?: boolean };

            // resolve stdin: injected (tests) else the live process pipe
            const stdin = runtime.stdin ?? processStdin();

            // run the handler and route its exit code through the injected exit
            const code = await runAppend(
                id,
                text,
                { ...(opts as AppendOptions), json: globals.json, remote: globals.remote },
                { ...runtime, stdin },
            );
            if (code !== 0) (runtime.exit ?? process.exit)(code);
            else runtime.exit?.(0);
        });

    return command;
}
