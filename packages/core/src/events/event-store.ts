// =============================================================================
// EVENT STORE — the port for the events table. A SEPARATE port from
// StorageAdapter (events don't bloat the context engine). Adapters in the same
// driver family implement this; the unique(event_id) dedupe is mapped to
// { inserted:false } — adapters NEVER throw for a duplicate event_id.
// =============================================================================

import type { Privacy } from './envelope';

// -- row ----------------------------------------------------------------------

// the events table row: extracted columns for query + the exact envelope JSON
// for round-trip fidelity. project_id is nullable (no project scoping in v1).
export type EventRow = {
    event_id: string;
    kind: string;
    source: string;
    subject: string;
    occurred_at: string;
    host: string;
    privacy: Privacy;
    received_at: string | null;
    delivery_state: DeliveryState;
    project_id: number | null;
    envelope: string;
};

// outbox state: 'committed' (received locally), 'sent' (delivered to a hub),
// 'pending' (queued, awaiting delivery). Replaces the old outbox/sent dirs.
export type DeliveryState = 'committed' | 'pending' | 'sent';

// filters for a tail query — all optional, ANDed together. `committed` scopes
// to the COMMITTED log (delivery_state 'committed') — what `tail` always reads,
// so a remote-emitter's still-pending rows never surface as committed facts.
export type EventListFilters = {
    limit: number;
    kind?: string;
    source?: string;
    subject?: string;
    committed?: boolean;
};

// counts of rows grouped by delivery_state
export type DeliveryCounts = { committed: number; pending: number; sent: number };

// -- port ---------------------------------------------------------------------

// the events table contract — every method an adapter must provide.
export interface EventStore {
    // insert one row. returns inserted:false on a duplicate event_id (unique
    // violation mapped here — NEVER thrown), idempotent by construction.
    insertEvent(row: EventRow): Promise<{ inserted: boolean }>;

    // the newest-LAST tail slice (callers reverse for chronological order),
    // filtered + capped by limit.
    listEvents(filters: EventListFilters): Promise<EventRow[]>;

    // rows still awaiting delivery, oldest first, optionally capped.
    pendingEvents(limit?: number): Promise<EventRow[]>;

    // rows not yet delivered to a hub — pending PLUS locally-committed (every
    // state except 'sent'), oldest first. Powers `flush --all` (backfill): a
    // context that started LOCAL has 'committed' rows a plain flush skips; once a
    // hub is configured, backfill ships them (the hub dedupes by event_id).
    undeliveredEvents(limit?: number): Promise<EventRow[]>;

    // mark a pending row delivered (delivery_state → 'sent').
    markDelivered(eventId: string): Promise<void>;

    // counts grouped by delivery_state.
    countByDeliveryState(): Promise<DeliveryCounts>;
}
