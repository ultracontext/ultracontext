// =============================================================================
// ISO TIMESTAMP — normalize every outbound timestamp to ISO-8601 UTC
// ('YYYY-MM-DDTHH:mm:ss.sssZ'), so all storage adapters yield one public shape.
// =============================================================================

// Postgres-style timestamptz: 'YYYY-MM-DD HH:mm:ss[.ffffff]±HH[:MM]' (space sep).
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/;

// shape a single outbound timestamp value to ISO-8601 UTC; never throws.
export function isoTimestamp(value: string | Date): string {
    // Date objects normalize directly
    if (value instanceof Date) return value.toISOString();

    // already-ISO (has the 'T' separator) — let Date normalize precision/offset
    if (value.includes('T')) {
        const ms = Date.parse(value);
        return isNaN(ms) ? value : new Date(ms).toISOString();
    }

    // Postgres-style (space separator) — rewrite to ISO then parse to UTC
    const match = PG_TIMESTAMP.exec(value);
    if (match) {
        const [, date, time, fraction = '', offHours, offMinutes = '00'] = match;
        const iso = `${date}T${time}${fraction}${offHours}:${offMinutes}`;
        const ms = Date.parse(iso);
        if (!isNaN(ms)) return new Date(ms).toISOString();
    }

    // unparseable — return verbatim (never break response shaping)
    return value;
}
