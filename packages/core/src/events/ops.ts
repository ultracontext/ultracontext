// =============================================================================
// EVENT OPS — the five capability ops over the EventStore port: emit, commit,
// tail, status, flush. IO-free (the store + transport are injected). Every op
// returns Result<T>.
// =============================================================================

import { ok, err, type Result } from '../result';
import { generateEventId } from '../public-ids';
import { validateEmitInput, validateEnvelope, DEFAULT_PRIVACY, type EventEnvelope, type EventInput } from './envelope';
import type { EventStore, EventRow, DeliveryState } from './event-store';

// -- shared: envelope → row ---------------------------------------------------

// project a validated envelope into a table row at a given delivery state
function toRow(env: EventEnvelope, delivery_state: DeliveryState): EventRow {
    return {
        event_id: env.event_id,
        kind: env.kind,
        source: env.source,
        subject: env.subject,
        occurred_at: env.occurred_at,
        host: env.host,
        privacy: env.privacy,
        received_at: env.received_at ?? null,
        delivery_state,
        project_id: null,
        envelope: JSON.stringify(env),
    };
}

// -- emitEvent ----------------------------------------------------------------

// options that shape an emit: the host fallback and whether the hub is local
export type EmitOptions = { hostDefault: string; localMode: boolean };

// build an envelope from caller input (filling defaults), validate it, then
// insert. localMode → committed + received_at now; remote → pending.
export async function emitEvent(store: EventStore, input: EventInput, opts: EmitOptions): Promise<Result<EventEnvelope>> {
    // validate the caller's input first (anything provided is checked)
    const inputCheck = validateEmitInput(input);
    if (!inputCheck.ok) return inputCheck;

    // fill defaults: id, occurred_at, host, privacy, priority, ok
    const now = new Date().toISOString();
    const candidate: EventEnvelope = {
        ...input,
        schema_version: 'uc.event.v1',
        event_id: input.event_id ?? generateEventId(),
        occurred_at: input.occurred_at ?? now,
        host: input.host ?? opts.hostDefault,
        privacy: (input.privacy as EventEnvelope['privacy']) ?? DEFAULT_PRIVACY,
        priority: input.priority ?? 50,
        ok: input.ok ?? true,
        received_at: opts.localMode ? now : undefined,
    };

    // re-validate the fully-built envelope
    const envCheck = validateEnvelope(candidate);
    if (!envCheck.ok) return envCheck;

    // local commit is atomic; remote lands pending for the flusher to deliver
    await store.insertEvent(toRow(envCheck.data, opts.localMode ? 'committed' : 'pending'));

    return ok(envCheck.data);
}

// -- commitEvent --------------------------------------------------------------

// hub side: parse a piped envelope, re-validate, set received_at=now, insert.
// a duplicate event_id is idempotent — committed:false, NOT an error.
export async function commitEvent(store: EventStore, envelopeJson: string): Promise<Result<{ committed: boolean; received_at: string | null; event_id: string }>> {
    // parse the JSON (malformed → invalid_input)
    let parsed: unknown;
    try {
        parsed = JSON.parse(envelopeJson);
    } catch {
        return err('invalid_input', 'envelope is not valid JSON');
    }

    // re-validate the envelope contract
    const envCheck = validateEnvelope(parsed);
    if (!envCheck.ok) return envCheck;

    // server sets/overwrites received_at at commit time (only meaningful on insert)
    const received_at = new Date().toISOString();
    const env: EventEnvelope = { ...envCheck.data, received_at };

    // insert committed — the unique(event_id) maps a dupe to inserted:false
    const { inserted } = await store.insertEvent(toRow(env, 'committed'));

    // NIT: on a dedup the row was NOT (re-)received now — report received_at null
    // (never a fresh 'now', which would mislead the caller into thinking it
    // re-stamped the existing row). A fresh insert reports the stamped time.
    return ok({ committed: inserted, received_at: inserted ? received_at : null, event_id: env.event_id });
}

// -- tailEvents ---------------------------------------------------------------

// the filters a tail accepts (kind/source/subject), all optional
export type TailFilters = { kind?: string; source?: string; subject?: string };

// options for a tail: limit (default 20) + filters
export type TailOptions = { limit?: number; filters?: TailFilters };

// the last N committed events in CHRONOLOGICAL order (oldest-of-the-tail first).
// returns parsed envelopes for round-trip fidelity.
export async function tailEvents(store: EventStore, opts: TailOptions): Promise<Result<EventEnvelope[]>> {
    const limit = opts.limit ?? 20;

    // committed-only: tail is the COMMITTED log (docs) — pending rows queued for a
    // remote hub never reached it and must not surface alongside real facts.
    const rows = await store.listEvents({ limit, committed: true, ...opts.filters });
    const envelopes = rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);

    return ok(envelopes);
}

// -- eventStatus --------------------------------------------------------------

// the resolved transport target + host id this status is reported for
export type StatusContext = { target: string; host: string };

// the status card: where events go, this host, and pending/sent counts
export type EventStatus = { target: string; host: string; pending: number; sent: number };

// report the server target, host, and pending/sent counts
export async function eventStatus(store: EventStore, ctx: StatusContext): Promise<Result<EventStatus>> {
    const counts = await store.countByDeliveryState();
    return ok({ target: ctx.target, host: ctx.host, pending: counts.pending, sent: counts.sent });
}

// -- flushPending -------------------------------------------------------------

// the transport: deliver one envelope JSON, resolve true on success
export type Deliver = (envelopeJson: string) => Promise<boolean>;

// retry every pending event via the transport; markDelivered on success.
// returns flushed/failed counts (callers exit 1 when failed > 0).
export async function flushPending(store: EventStore, deliver: Deliver): Promise<Result<{ flushed: number; failed: number }>> {
    const pending = await store.pendingEvents();

    // attempt each in turn; a failure leaves the row pending for the next flush
    let flushed = 0;
    let failed = 0;
    for (const row of pending) {
        const delivered = await deliver(row.envelope);
        if (delivered) {
            await store.markDelivered(row.event_id);
            flushed += 1;
        } else {
            failed += 1;
        }
    }

    return ok({ flushed, failed });
}
