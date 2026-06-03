// =============================================================================
// ENVELOPE — the uc.event.v1 contract: types + pure validators. The shape and
// every rule below mirror apps/docs/concepts/events.mdx (the contract). No IO.
// =============================================================================

import { ok, err, type Result } from '../result';

// -- constants ----------------------------------------------------------------

// the only schema version this contract knows
export const SCHEMA_VERSION = 'uc.event.v1';

// the four privacy levels an event may declare
export const PRIVACY_LEVELS = ['public', 'internal', 'metadata_only', 'sensitive_ref'] as const;
export type Privacy = (typeof PRIVACY_LEVELS)[number];

// driver default per docs (concepts/events.mdx: "Drivers default to metadata_only")
export const DEFAULT_PRIVACY: Privacy = 'metadata_only';

// the four token fields share these rules: non-empty, ≤128 chars, restricted charset
const TOKEN_MAX = 128;
const TOKEN_CHARSET = /^[A-Za-z0-9_\-.:/]+$/;

// -- types --------------------------------------------------------------------

// a structured error carried on a failure event
export type EventError = { class: string; message: string; retryable: boolean };

// the full uc.event.v1 envelope — required + server-set + optional fields
export type EventEnvelope = {
    schema_version: typeof SCHEMA_VERSION;
    event_id: string;
    kind: string;
    source: string;
    subject: string;
    occurred_at: string;
    host: string;
    privacy: Privacy;
    received_at?: string;
    actor?: string;
    run_id?: string;
    trace_id?: string;
    parent_event_id?: string;
    priority?: number;
    ok?: boolean;
    payload_ref?: string;
    payload_hash?: string;
    counts?: Record<string, number>;
    labels?: Record<string, string>;
    error?: EventError | null;
};

// caller input to emit — server-set + token defaults are filled in by emitEvent
export type EventInput = {
    event_id?: string;
    kind: string;
    source: string;
    subject: string;
    occurred_at?: string;
    host?: string;
    privacy?: string;
    actor?: string;
    run_id?: string;
    trace_id?: string;
    parent_event_id?: string;
    priority?: number;
    ok?: boolean;
    payload_ref?: string;
    payload_hash?: string;
    counts?: Record<string, number>;
    labels?: Record<string, string>;
    error?: EventError | null;
};

// -- shared field checks ------------------------------------------------------

// a plain object (not null, not an array)
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// one token field: present, string, non-empty, ≤128 chars, legal charset
function checkToken(value: unknown, field: string): string | null {
    if (typeof value !== 'string' || value.length === 0) return `${field} is required`;
    if (value.length > TOKEN_MAX) return `${field} exceeds ${TOKEN_MAX} chars`;
    if (!TOKEN_CHARSET.test(value)) return `${field} has an illegal character`;
    return null;
}

// privacy must be one of the four enum values
function checkPrivacy(value: unknown): string | null {
    return PRIVACY_LEVELS.includes(value as Privacy) ? null : `privacy must be one of ${PRIVACY_LEVELS.join(', ')}`;
}

// priority (when present) is an integer 0–100
function checkPriority(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
        return 'priority must be an integer 0–100';
    }
    return null;
}

// ok (when present) is a boolean
function checkOk(value: unknown): string | null {
    if (value === undefined) return null;
    return typeof value === 'boolean' ? null : 'ok must be a boolean';
}

// payload_hash (when present) must start with 'sha256:'
function checkPayloadHash(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.startsWith('sha256:')) return "payload_hash must start with 'sha256:'";
    return null;
}

// counts (when present) is a string→int map
function checkCounts(value: unknown): string | null {
    if (value === undefined) return null;
    if (!isObject(value)) return 'counts must be an object';
    for (const v of Object.values(value)) {
        if (typeof v !== 'number' || !Number.isInteger(v)) return 'counts values must be integers';
    }
    return null;
}

// labels (when present) is a string→string map with values 1–256 chars
function checkLabels(value: unknown): string | null {
    if (value === undefined) return null;
    if (!isObject(value)) return 'labels must be an object';
    for (const v of Object.values(value)) {
        if (typeof v !== 'string' || v.length < 1 || v.length > 256) return 'labels values must be strings 1–256 chars';
    }
    return null;
}

// error (when present) is null or { class, message, retryable:boolean }
function checkError(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (!isObject(value)) return 'error must be an object or null';
    if (typeof value.class !== 'string') return 'error.class is required';
    if (typeof value.message !== 'string') return 'error.message is required';
    if (typeof value.retryable !== 'boolean') return 'error.retryable must be a boolean';
    return null;
}

// every optional-field rule, applied to whatever shape is on hand
function checkOptionalFields(env: Record<string, unknown>): string | null {
    return (
        checkPriority(env.priority) ??
        checkOk(env.ok) ??
        checkPayloadHash(env.payload_hash) ??
        checkCounts(env.counts) ??
        checkLabels(env.labels) ??
        checkError(env.error)
    );
}

// -- validateEnvelope ---------------------------------------------------------

// validate a full envelope (committed or pending): schema, tokens, every rule.
export function validateEnvelope(input: unknown): Result<EventEnvelope> {
    if (!isObject(input)) return err('invalid_input', 'envelope must be an object');

    // schema_version is a hard literal
    if (input.schema_version !== SCHEMA_VERSION) {
        return err('invalid_input', `schema_version must be '${SCHEMA_VERSION}'`);
    }

    // the four token fields
    for (const field of ['event_id', 'kind', 'source', 'subject'] as const) {
        const msg = checkToken(input[field], field);
        if (msg) return err('invalid_input', msg);
    }

    // host is a required non-empty string (not a strict token — hostnames vary)
    if (typeof input.host !== 'string' || input.host.length === 0) {
        return err('invalid_input', 'host is required');
    }

    // occurred_at is required and must parse as a date
    if (typeof input.occurred_at !== 'string' || isNaN(Date.parse(input.occurred_at))) {
        return err('invalid_input', 'occurred_at must be an ISO-8601 timestamp');
    }

    // privacy enum
    const privacyMsg = checkPrivacy(input.privacy);
    if (privacyMsg) return err('invalid_input', privacyMsg);

    // every optional field rule
    const optMsg = checkOptionalFields(input);
    if (optMsg) return err('invalid_input', optMsg);

    return ok(input as EventEnvelope);
}

// -- validateEmitInput --------------------------------------------------------

// validate caller emit input — required tokens are mandatory; privacy/event_id/
// occurred_at/host are filled by emitEvent, but anything provided is checked now.
export function validateEmitInput(input: unknown): Result<EventInput> {
    if (!isObject(input)) return err('invalid_input', 'emit input must be an object');

    // the three caller-required token fields
    for (const field of ['kind', 'source', 'subject'] as const) {
        const msg = checkToken(input[field], field);
        if (msg) return err('invalid_input', msg);
    }

    // event_id is optional here (defaulted), but validated if given
    if (input.event_id !== undefined) {
        const msg = checkToken(input.event_id, 'event_id');
        if (msg) return err('invalid_input', msg);
    }

    // privacy is optional here (defaulted), but validated if given
    if (input.privacy !== undefined) {
        const msg = checkPrivacy(input.privacy);
        if (msg) return err('invalid_input', msg);
    }

    // occurred_at optional (defaulted), validated if given
    if (input.occurred_at !== undefined && (typeof input.occurred_at !== 'string' || isNaN(Date.parse(input.occurred_at)))) {
        return err('invalid_input', 'occurred_at must be an ISO-8601 timestamp');
    }

    // every optional field rule still applies
    const optMsg = checkOptionalFields(input);
    if (optMsg) return err('invalid_input', optMsg);

    return ok(input as EventInput);
}
