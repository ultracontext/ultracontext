// =============================================================================
// event — the TOP-LEVEL `uc event <emit|tail|status|flush|commit>` family. Maps
// the documented surface (apps/docs/concepts/events.mdx) onto the core event ops
// over an EventStore + a pluggable transport. Local-first: with no hub
// configured, emit IS the commit (in-db); with a ssh remote, emit queues pending
// and flush retries via `ssh <hub> 'uc event commit --from-stdin'`.
// Pipe-aware: data → stdout, status/errors → stderr. tail ALWAYS emits one
// compact JSON envelope per line — the Hermes consumer contract.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import {
    emitEvent,
    commitEvent,
    tailEvents,
    eventStatus,
    flushPending,
    type EventInput,
    type EventError,
    type EventStore,
    type Deliver,
} from '@ultracontext/core';

import { dbUrl as defaultDbUrl } from '../../../lib/config';
import { configDir as defaultConfigDir } from '@ultracontext/sync';
import { openEventStore } from '../../../lib/events/store';
import { resolveTransport, type StdinRunner, type Transport, type RemoteTailFilters } from '../../../lib/events/transport';
import { parseCounts, parseLabels } from '../../../lib/events/kv';
import { emit, status, outputError } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps every action reads: store + transport seams + io. The store/configDir/
// runner overrides let tests drive a temp db + a fake ssh runner; the defaults
// open the real local db (UC_DB_URL else ~/.ultracontext/uc.db) + real config.
export type EventDeps = {
    store?: EventStore;
    dbUrl?: string;
    configDir?: string;
    runner?: StdinRunner;
    fetch?: typeof fetch;
    stdin?: () => Promise<string>;
    io?: Io;
};

// -- options ------------------------------------------------------------------

// the global --json flag flows in from the program root
type JsonOpt = { json?: boolean };

// `uc event emit` flags — the canonical 2.0 envelope surface (lib.rs
// print_event_help). --event-id carries the relay's idempotency id; the three
// --error-* flags assemble into the envelope error object (relay error events).
export type EmitOpts = JsonOpt & {
    eventId?: string;
    kind: string;
    source: string;
    subject: string;
    privacy?: string;
    occurredAt?: string;
    actor?: string;
    runId?: string;
    traceId?: string;
    parentEventId?: string;
    priority?: number;
    ok?: boolean;
    payloadRef?: string;
    payloadHash?: string;
    count?: string[];
    label?: string[];
    errorClass?: string;
    errorMessage?: string;
    errorRetryable?: boolean;
};

// `uc event tail` flags — limit + the documented kind/source/subject filters.
// `--local` forces reading the local db even when a remote hub is configured
// (the emitter's own debug view, bypassing the hub read over ssh).
export type TailOpts = JsonOpt & { limit?: number; kind?: string; source?: string; subject?: string; local?: boolean };

// -- shared store + transport resolution --------------------------------------

// open the store (injected for tests, else the local db) — returned alongside
// the resolved transport so each action shares one resolution. The transport
// SELECTS its own deliver/tail (api coord → HTTP, else ssh, else local).
async function resolve(deps: EventDeps) {
    const transport = await resolveTransport({ configDir: deps.configDir ?? defaultConfigDir(), runner: deps.runner, fetch: deps.fetch });
    const store = deps.store ?? (await openEventStore(deps.dbUrl ?? defaultDbUrl()));
    return { transport, store };
}

// -- emit ---------------------------------------------------------------------

// `uc event emit` → build + validate + insert. local hub → committed; remote →
// pending then attempt delivery now. prints the event_id (bare / under --json).
export async function emitAction(opts: EmitOpts, deps: EventDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        // assemble the EventInput from flags (k=v maps parsed + validated here).
        // event_id (when given) is passed through so the relay's idempotency id is
        // preserved; the three --error-* flags assemble into the error object.
        const input: EventInput = {
            event_id: opts.eventId,
            kind: opts.kind,
            source: opts.source,
            subject: opts.subject,
            privacy: opts.privacy,
            occurred_at: opts.occurredAt,
            actor: opts.actor,
            run_id: opts.runId,
            trace_id: opts.traceId,
            parent_event_id: opts.parentEventId,
            priority: opts.priority,
            ok: opts.ok,
            payload_ref: opts.payloadRef,
            payload_hash: opts.payloadHash,
            counts: parseCounts(opts.count),
            labels: parseLabels(opts.label),
            error: buildError(opts),
        };

        // resolve the hub, then emit through the core op (localMode shapes state)
        const { transport, store } = await resolve(deps);
        const result = await emitEvent(store, input, { hostDefault: transport.host, localMode: transport.localMode });
        if (!result.ok) throw new Error(result.message);

        // remote hub → attempt delivery now; a failure leaves the row pending.
        // the row stored the EXACT envelope JSON — re-stringify the parsed one.
        if (!transport.localMode) await tryDeliver(store, transport.deliver, result.data.event_id, JSON.stringify(result.data), io);

        // data → stdout: bare id in human mode, the envelope under --json
        emit(result.data, { json: opts.json, human: () => result.data.event_id }, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// assemble the envelope error object from the three relay --error-* flags. Built
// only when ANY is present (matching 2.0's render_event_error); class/message
// default to '' and retryable to false so the partial relay form still validates.
function buildError(opts: EmitOpts): EventError | undefined {
    if (opts.errorClass === undefined && opts.errorMessage === undefined && opts.errorRetryable === undefined) return undefined;
    return { class: opts.errorClass ?? '', message: opts.errorMessage ?? '', retryable: opts.errorRetryable ?? false };
}

// attempt one immediate delivery of a freshly-emitted remote event; on failure
// mention the hub install so the row stays pending with a clear hint on stderr.
async function tryDeliver(store: EventStore, deliver: Deliver, eventId: string, envelopeJson: string, io?: Io): Promise<void> {
    const delivered = await deliver(envelopeJson);
    if (delivered) {
        await store.markDelivered(eventId);
    } else {
        status('event queued (pending) — hub unreachable or `uc` not installed there; run `uc event flush` to retry', io);
    }
}

// -- tail ---------------------------------------------------------------------

// `uc event tail` → the last N committed events in chronological order. ALWAYS
// one compact JSON envelope per line on stdout (the consumer contract), in BOTH
// human and --json modes — so the Hermes plugin parses identical output either way.
// With a REMOTE hub configured, tail reads the HUB's canonical log through the
// transport's own tail (HTTP GET /events for an api coord, else ssh over the login
// shell); --local forces the local db. The transport SELECTS which — tail itself
// never branches on http-vs-ssh.
export async function tailAction(opts: TailOpts, deps: EventDeps = {}): Promise<number> {
    const io = deps.io;
    const filters = { kind: opts.kind, source: opts.source, subject: opts.subject };

    try {
        // resolve the hub: a remote hub (and no --local override) → tail it through
        // the transport's native tail (HTTP or ssh, the transport already chose).
        const transport = await resolveTransport({ configDir: deps.configDir ?? defaultConfigDir(), runner: deps.runner, fetch: deps.fetch });
        if (!transport.localMode && !opts.local && transport.tail) {
            return await tailRemote(transport.target, transport.tail, { limit: opts.limit, ...filters }, io);
        }

        // local hub OR --local override → read the local committed log from the db
        const store = deps.store ?? (await openEventStore(deps.dbUrl ?? defaultDbUrl()));
        const result = await tailEvents(store, { limit: opts.limit, filters });
        if (!result.ok) throw new Error(result.message);

        // one compact JSON object per line, always — never a JSON array
        emitLines(result.data, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// tail the hub through the transport's tail: filter values are charset-validated
// by the ssh builder (an injection attempt throws → exit 1); the HTTP tail passes
// them as query params. A failure (hub down / `uc` missing / non-2xx) is reported
// honestly naming the target — NO silent fallback to the local db.
async function tailRemote(target: string, tail: NonNullable<Transport['tail']>, filters: RemoteTailFilters, io?: Io): Promise<number> {
    const result = await tail(filters);

    // the hub was unreachable → a clear error naming the target; exit 1 (no fallback)
    if (!result.ok) {
        const hint = result.stderr.trim() || `exited ${result.code}`;
        throw new Error(`cannot read the event hub ${target} (${hint}) — run \`uc event tail --local\` for this machine's own view`);
    }

    // the hub lines are already the line-JSON contract — pass them through verbatim
    const stdout = io?.stdout ?? process.stdout;
    for (const line of result.lines) stdout.write(line + '\n');
    return 0;
}

// write one compact JSON object per line straight to stdout (data stream)
function emitLines(envelopes: unknown[], io?: Io): void {
    const stdout = io?.stdout ?? process.stdout;
    for (const env of envelopes) stdout.write(JSON.stringify(env) + '\n');
}

// -- status -------------------------------------------------------------------

// `uc event status` → the resolved target + host + pending / committed counts.
// The docs report "pending / committed". A locally-committed row reaches its hub
// (the local db) the instant it's emitted — delivery_state 'committed'. A row
// delivered to a remote hub is 'sent'. So the "committed" figure (events that
// reached a hub) is committed-rows in local mode, sent-rows in remote mode.
export async function statusAction(opts: JsonOpt, deps: EventDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        const { transport, store } = await resolve(deps);
        const result = await eventStatus(store, { target: transport.target, host: transport.host });
        if (!result.ok) throw new Error(result.message);

        // committed = events that reached a hub: local committed rows, else sent
        const counts = await store.countByDeliveryState();
        const card = { ...result.data, committed: transport.localMode ? counts.committed : counts.sent };

        // data → stdout (JSON line in machine mode, terse human card otherwise)
        emit(card, { json: opts.json, human: (d) => humanStatus(d as typeof card) }, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// render the status card as terse human lines (pending / committed per the docs)
function humanStatus(s: { target: string; host: string; pending: number; committed: number }): string {
    return `target: ${s.target}\nhost: ${s.host}\npending: ${s.pending}\ncommitted: ${s.committed}`;
}

// -- flush --------------------------------------------------------------------

// `uc event flush [--all]` → retry every pending event via the transport. prints
// `flushed: N`; exits 1 when any event failed (it stays pending for next flush).
// --all also BACKFILLS locally-committed events (a context that started LOCAL)
// to the configured hub — the hub dedupes by event_id, so it is safe to re-run.
export async function flushAction(opts: JsonOpt & { all?: boolean }, deps: EventDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        const { transport, store } = await resolve(deps);

        // backfill needs a hub to ship to — refuse --all when none is configured
        if (opts.all && transport.localMode) {
            throw new Error('no remote configured — `flush --all` backfills local events to a hub; set one with `uc remote set <target>`');
        }

        const result = await flushPending(store, transport.deliver, { all: opts.all });
        if (!result.ok) throw new Error(result.message);

        // data → stdout (envelope under --json, `flushed: N` line in human mode)
        emit(result.data, { json: opts.json, human: (d) => `flushed: ${(d as typeof result.data).flushed}` }, io);

        // any failure → exit 1; surface the hint on stderr in human mode
        if (result.data.failed > 0) {
            status(`${result.data.failed} event(s) still pending — hub unreachable or \`uc\` not installed there`, io);
            return 1;
        }
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- commit -------------------------------------------------------------------

// `uc event commit --from-stdin` → the hub side. Read a piped envelope,
// re-validate, set received_at, insert (dedupe by event_id). prints
// `committed: 1` on a fresh insert, `committed: 0` on a duplicate (idempotent).
export async function commitAction(opts: JsonOpt & { fromStdin?: boolean }, deps: EventDeps = {}): Promise<number> {
    const io = deps.io;

    try {
        // commit only reads its envelope from stdin (the ssh transport target)
        if (!opts.fromStdin) throw new Error('usage: uc event commit --from-stdin');

        const envelopeJson = await (deps.stdin ?? readStdin)();
        const { store } = await resolve(deps);
        const result = await commitEvent(store, envelopeJson);
        if (!result.ok) throw new Error(result.message);

        // data → stdout: `committed: 1|0` (a dupe is committed:0, NOT an error)
        const committed = result.data.committed ? 1 : 0;
        emit({ ...result.data, committed }, { json: opts.json, human: () => `committed: ${committed}` }, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json: opts.json });
    }
}

// read all of stdin to a string (the real piped-envelope source)
async function readStdin(): Promise<string> {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

// -- commander bridge ---------------------------------------------------------

// the minimal Command surface the bridge reads
type AnyCommand = { optsWithGlobals(): unknown };

// read the global --json flag off any command in the tree
function jsonFlag(cmd: AnyCommand): boolean {
    return Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
}

// run an action with live process io, exiting non-zero on its returned code
function bridge(run: (json: boolean) => Promise<number>) {
    return async (cmd: AnyCommand) => {
        const code = await run(jsonFlag(cmd));
        if (code !== 0) process.exit(code);
    };
}

// -- command factory ----------------------------------------------------------

// build the top-level `event` Commander group with every subcommand wired
export function buildEventCommand(): Command {
    const event = new Command('event').description('emit, tail, and commit uc.event.v1 events');

    // emit — build + validate + insert an envelope (local commit or remote queue)
    event
        .command('emit')
        .description('emit a uc.event.v1 event')
        .requiredOption('--kind <kind>', 'dotted verb-noun kind (e.g. claude.session.updated)')
        .requiredOption('--source <source>', 'component that emitted or observed it')
        .requiredOption('--subject <subject>', 'stable thing it is about')
        .option('--event-id <id>', "caller-provided id (relay idempotency); generated when omitted")
        .option('--privacy <level>', 'public | internal | metadata_only | sensitive_ref (default metadata_only)')
        .option('--occurred-at <iso>', 'ISO-8601 time it happened (default now)')
        .option('--actor <actor>', 'who caused it')
        .option('--run-id <id>', 'id of one agent/tool run')
        .option('--trace-id <id>', 'id of a larger causal chain')
        .option('--parent-event-id <id>', 'direct causal parent event id')
        .option('--priority <n>', 'priority 0-100 (default 50)', (v) => parseInt(v, 10))
        .option('--ok <bool>', 'success marker (default true)', (v) => v === 'true')
        .option('--payload-ref <ref>', 'pointer to the file/context with the heavy details')
        .option('--payload-hash <hash>', "hash of that payload (must start sha256:)")
        .option('--count <k=v...>', 'numeric counter pair (repeatable)', collect, [])
        .option('--label <k=v...>', 'string label pair (repeatable)', collect, [])
        .option('--error-class <class>', 'error class (assembles the envelope error object)')
        .option('--error-message <message>', 'error message (assembles the envelope error object)')
        .option('--error-retryable <bool>', 'whether the error is retryable', (v) => v === 'true')
        .action((opts, cmd) => bridge((json) => emitAction({ ...opts, json }))(cmd));

    // tail — read the chronological committed log as one JSON object per line.
    // reads the hub over ssh when one is configured; --local forces the local db.
    event
        .command('tail')
        .description('read the committed event log (one JSON object per line)')
        .option('--limit <n>', 'how many events to tail (default 20)', (v) => parseInt(v, 10))
        .option('--kind <kind>', 'filter by kind')
        .option('--source <source>', 'filter by source')
        .option('--subject <subject>', 'filter by subject')
        .option('--local', "read this machine's own local db, even with a remote hub configured")
        .action((opts, cmd) => bridge((json) => tailAction({ ...opts, json }))(cmd));

    // status — pending vs sent counts + the resolved target/host
    event.command('status').description('show pending / sent counts').action((_opts, cmd) => bridge((json) => statusAction({ json }))(cmd));

    // flush — retry pending; --all also backfills locally-committed events to the hub
    event
        .command('flush')
        .description('retry anything still pending (--all also backfills local events to the hub)')
        .option('--all', 'also ship locally-committed events (backfill after configuring a remote)')
        .action((opts, cmd) => bridge((json) => flushAction({ json, all: Boolean(opts.all) }))(cmd));

    // commit — hub side: read a piped envelope, set received_at, insert (dedupes)
    event
        .command('commit')
        .description('commit a piped envelope (hub side; the ssh transport target)')
        .option('--from-stdin', 'read the envelope JSON from stdin')
        .action((opts, cmd) => bridge((json) => commitAction({ ...opts, json }))(cmd));

    return event as unknown as Command;
}

// collect a repeated option's values into an array (Commander reducer)
function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}
