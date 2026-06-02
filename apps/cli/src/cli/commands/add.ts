// =============================================================================
// add — `uc add` quick-capture. Append one message (or create the cwd default
// context on first write). Body sources: positional text | stdin | --json | a
// --meta key=val pair set. Flags: --role, --context <id>, --new. Local-first:
// the resolved ContextClient uses the centralized env-aware config (UC_DB_URL /
// UC_PROJECT_DIR) — no per-command env reads here.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { resolveClient } from '../../../lib/resolve-client';
import { projectDir } from '../../../lib/config';
import { emit, outputError, shouldJson } from '../../../lib/output';
import type { Message } from '../../../lib/context-client';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io + stdin + exit injected by tests; real process bindings are the defaults
type Runtime = {
    io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean };
    stdin?: AsyncIterable<string>;
    exit?: (code?: number) => void;
};

// -- parsed options -----------------------------------------------------------

// commander-collected flags for the verb
type AddOptions = {
    role?: string;
    meta?: string[];
    context?: string;
    new?: boolean;
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
    opts: AddOptions,
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

    // assemble content + optional role + --meta metadata
    const message: Message = { content };
    if (opts.role) message.role = opts.role;

    const metadata = parseMeta(opts.meta);
    if (Object.keys(metadata).length > 0) message.metadata = metadata;

    return message;
}

// -- handler ------------------------------------------------------------------

// parse input, append through the client, and emit the appended view + version
export async function runAdd(text: string | undefined, opts: AddOptions, runtime: Runtime): Promise<number> {
    const io = runtime.io;
    const json = shouldJson({ json: Boolean(opts.json) }, io);

    try {
        // assemble the message before touching storage so bad input fails fast
        const message = await buildMessage(text, opts, runtime.stdin);

        // env-aware project scope (UC_PROJECT_DIR else cwd) from centralized config
        const cwd = projectDir();

        // --new targets a synthetic scope so resolve-or-create makes a fresh context;
        // omit cwd otherwise so resolveClient uses the centralized env-aware default
        const scope = opts.new ? `${cwd}/new-${Date.now()}-${Math.random().toString(36).slice(2)}` : undefined;
        const client = await resolveClient({ remote: opts.remote, cwd: scope });

        // append to the explicit --context id, else the (possibly new) default
        const result = await client.add({ id: opts.context, messages: [message] });

        // the resolved context id rides along the envelope for agents to chain on
        const view = { data: result.data, version: result.version, id: result.id };

        // data → stdout; one JSON line in machine mode, a short line otherwise
        emit(view, { json, human: (d) => `captured (v${(d as typeof view).version})` }, io);
        return 0;
    } catch (error) {
        // failure → stderr only, non-zero exit (no data on stdout)
        return outputError(error, { ...io, json });
    }
}

// -- command factory ----------------------------------------------------------

// build the `uc add` Command, wiring its action to the injectable handler
export function buildAddCommand(runtime: Runtime = {}): Command {
    const command = new Command('add');

    // quick-capture surface: positional body + role/meta/target flags
    command
        .description('append a message to a context (quick-capture)')
        .argument('[text]', 'message body (omit to read stdin)')
        .option('--role <role>', 'message role (e.g. user, assistant)')
        .option('--meta <pair...>', 'metadata key=val (repeatable)')
        .option('--context <id>', 'target an explicit context id')
        .option('--new', 'force a brand-new context')
        .option('--json [body]', 'machine output, or parse a raw message object')
        .action(async (text, opts, cmd) => {
            // fold the global --remote off the program root into the verb options
            const remote = Boolean((cmd.optsWithGlobals() as { remote?: boolean }).remote);

            // run the handler and route its exit code through the injected exit
            const code = await runAdd(text, { ...(opts as AddOptions), remote }, runtime);
            if (code !== 0) (runtime.exit ?? process.exit)(code);
            else runtime.exit?.(0);
        });

    return command;
}
