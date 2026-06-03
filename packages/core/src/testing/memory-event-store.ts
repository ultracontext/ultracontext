import type { EventStore, EventRow, EventListFilters, DeliveryCounts } from '../events/event-store';

// -- In-memory EventStore double ----------------------------------------------

// a test double for the EventStore port. UNIQUE(event_id) is enforced in memory
// → insertEvent returns inserted:false on a dupe (never throws), matching the
// adapter contract. Insertion order is preserved as the table's natural order.
export class MemoryEventStore implements EventStore {
    private rows: EventRow[] = [];

    // insert one row; dedupe on event_id (the unique constraint, in memory)
    async insertEvent(row: EventRow): Promise<{ inserted: boolean }> {
        if (this.rows.some((r) => r.event_id === row.event_id)) return { inserted: false };
        this.rows.push({ ...row });
        return { inserted: true };
    }

    // newest-LAST tail slice: filter, order by occurred_at (then insertion), cap
    async listEvents(filters: EventListFilters): Promise<EventRow[]> {
        const matched = this.rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => !filters.committed || r.delivery_state === 'committed')
            .filter(({ r }) => !filters.kind || r.kind === filters.kind)
            .filter(({ r }) => !filters.source || r.source === filters.source)
            .filter(({ r }) => !filters.subject || r.subject === filters.subject)
            .sort((a, b) => a.r.occurred_at.localeCompare(b.r.occurred_at) || a.i - b.i)
            .map(({ r }) => r);

        // take the newest `limit` rows, returned newest-LAST
        return matched.slice(Math.max(0, matched.length - filters.limit));
    }

    // pending rows, oldest first, optionally capped
    async pendingEvents(limit?: number): Promise<EventRow[]> {
        const pending = this.rows.filter((r) => r.delivery_state === 'pending');
        return limit === undefined ? pending : pending.slice(0, limit);
    }

    // flip a pending row to 'sent'
    async markDelivered(eventId: string): Promise<void> {
        const row = this.rows.find((r) => r.event_id === eventId);
        if (row) row.delivery_state = 'sent';
    }

    // counts grouped by delivery_state
    async countByDeliveryState(): Promise<DeliveryCounts> {
        const counts: DeliveryCounts = { committed: 0, pending: 0, sent: 0 };
        for (const r of this.rows) counts[r.delivery_state] += 1;
        return counts;
    }

    // test helper — every stored row in insertion order
    getAllRows(): EventRow[] {
        return this.rows;
    }
}
