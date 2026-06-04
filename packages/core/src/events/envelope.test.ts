import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnvelope, validateEmitInput } from './envelope';

// =============================================================================
// ENVELOPE — validation rules for the uc.event.v1 contract (pure functions).
// Each rule gets its own RED-first case; docs at apps/docs/concepts/events.mdx
// are the contract.
// =============================================================================

// a minimal valid committed envelope used as the baseline for negative cases
function validEnvelope() {
    return {
        schema_version: 'uc.event.v1',
        event_id: 'evt_abc123',
        kind: 'claude.session.updated',
        source: 'claude-web-driver',
        subject: 'claude:session:abc123',
        occurred_at: '2026-06-03T06:25:02.978Z',
        host: 'fabios-mac-mini',
        privacy: 'metadata_only',
    };
}

describe('validateEnvelope — required fields', () => {
    it('accepts a minimal valid envelope', () => {
        const r = validateEnvelope(validEnvelope());
        assert.equal(r.ok, true);
    });

    it('rejects a non-object input', () => {
        const r = validateEnvelope(null);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'invalid_input');
    });

    it('rejects a wrong schema_version', () => {
        const r = validateEnvelope({ ...validEnvelope(), schema_version: 'uc.event.v2' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /schema_version/);
    });

    it('rejects a missing kind', () => {
        const env = validEnvelope() as Record<string, unknown>;
        delete env.kind;
        const r = validateEnvelope(env);
        assert.equal(r.ok, false);
    });

    it('rejects a missing source', () => {
        const env = validEnvelope() as Record<string, unknown>;
        delete env.source;
        assert.equal(validateEnvelope(env).ok, false);
    });

    it('rejects a missing subject', () => {
        const env = validEnvelope() as Record<string, unknown>;
        delete env.subject;
        assert.equal(validateEnvelope(env).ok, false);
    });

    it('rejects a missing host', () => {
        const env = validEnvelope() as Record<string, unknown>;
        delete env.host;
        assert.equal(validateEnvelope(env).ok, false);
    });
});

describe('validateEnvelope — occurred_at ISO', () => {
    it('rejects a non-ISO occurred_at', () => {
        const r = validateEnvelope({ ...validEnvelope(), occurred_at: 'yesterday' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /occurred_at/);
    });
});

describe('validateEnvelope — privacy enum', () => {
    it('accepts each of the four privacy levels', () => {
        for (const privacy of ['public', 'internal', 'metadata_only', 'sensitive_ref']) {
            assert.equal(validateEnvelope({ ...validEnvelope(), privacy }).ok, true, privacy);
        }
    });

    it('rejects an unknown privacy level', () => {
        const r = validateEnvelope({ ...validEnvelope(), privacy: 'secret' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /privacy/);
    });
});

describe('validateEnvelope — token rules', () => {
    it('rejects an empty token', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), kind: '' }).ok, false);
    });

    it('rejects a token over 128 chars', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), event_id: 'evt_' + 'a'.repeat(130) }).ok, false);
    });

    it('rejects a token with an illegal char', () => {
        const r = validateEnvelope({ ...validEnvelope(), subject: 'claude session' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /subject/);
    });

    it('accepts the full legal charset', () => {
        const r = validateEnvelope({ ...validEnvelope(), subject: 'a-Z0_9.:/x' });
        assert.equal(r.ok, true);
    });
});

describe('validateEnvelope — priority range', () => {
    it('accepts a priority of 0 and 100', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), priority: 0 }).ok, true);
        assert.equal(validateEnvelope({ ...validEnvelope(), priority: 100 }).ok, true);
    });

    it('rejects a priority below 0', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), priority: -1 }).ok, false);
    });

    it('rejects a priority above 100', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), priority: 101 }).ok, false);
    });

    it('rejects a non-integer priority', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), priority: 1.5 }).ok, false);
    });
});

describe('validateEnvelope — ok flag', () => {
    it('accepts a boolean ok', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), ok: false }).ok, true);
    });

    it('rejects a non-boolean ok', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), ok: 'yes' }).ok, false);
    });
});

describe('validateEnvelope — payload_hash', () => {
    it('accepts a sha256: prefixed hash', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), payload_hash: 'sha256:9f86d0' }).ok, true);
    });

    it('rejects a hash without the sha256: prefix', () => {
        const r = validateEnvelope({ ...validEnvelope(), payload_hash: 'md5:abc' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /payload_hash/);
    });
});

describe('validateEnvelope — counts', () => {
    it('accepts integer count values', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), counts: { listed: 10, synced: 0 } }).ok, true);
    });

    it('rejects a non-integer count value', () => {
        const r = validateEnvelope({ ...validEnvelope(), counts: { listed: 1.5 } });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /counts/);
    });

    it('rejects a non-numeric count value', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), counts: { listed: 'ten' } }).ok, false);
    });
});

describe('validateEnvelope — labels', () => {
    it('accepts string label values 1-256 chars', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), labels: { app: 'claude' } }).ok, true);
    });

    it('rejects an empty label value', () => {
        const r = validateEnvelope({ ...validEnvelope(), labels: { app: '' } });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /labels/);
    });

    it('rejects a label value over 256 chars', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), labels: { app: 'x'.repeat(257) } }).ok, false);
    });

    it('rejects a non-string label value', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), labels: { app: 5 } }).ok, false);
    });
});

describe('validateEnvelope — error object', () => {
    it('accepts a null error', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), error: null }).ok, true);
    });

    it('accepts a well-formed error object', () => {
        const error = { class: 'SyncError', message: 'boom', retryable: true };
        assert.equal(validateEnvelope({ ...validEnvelope(), error }).ok, true);
    });

    it('rejects an error missing class', () => {
        const r = validateEnvelope({ ...validEnvelope(), error: { message: 'boom', retryable: true } });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /error/);
    });

    it('rejects an error with a non-boolean retryable', () => {
        assert.equal(validateEnvelope({ ...validEnvelope(), error: { class: 'E', message: 'm', retryable: 1 } }).ok, false);
    });
});

// =============================================================================
// BUG 3 — explicit JSON null on an optional field is "absent", not invalid. The
// legacy events.jsonl (and our own emitted events) carry payload_hash:null,
// payload_ref:null, error:null, actor:null, etc. A `typeof !== 'string'` check
// that only exempts `undefined` rejected 67 of 82 legacy events on import.
// =============================================================================

describe('validateEnvelope — explicit null on optional fields (legacy compat)', () => {
    // every optional field carrying an explicit null is treated as not-provided
    it('accepts an envelope with payload_hash:null + error:null + every optional null', () => {
        const env = {
            ...validEnvelope(),
            payload_hash: null,
            payload_ref: null,
            actor: null,
            run_id: null,
            trace_id: null,
            parent_event_id: null,
            priority: null,
            ok: null,
            counts: null,
            labels: null,
            error: null,
        };
        const r = validateEnvelope(env);
        assert.equal(r.ok, true);
    });

    // a NON-null bad value on the same field is still rejected (null ≠ any value)
    it('still rejects a non-null bad payload_hash', () => {
        const r = validateEnvelope({ ...validEnvelope(), payload_hash: 'nope' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /payload_hash/);
    });

    // the REAL legacy sample line (nulls everywhere optional) round-trips
    it('validates the real legacy events.jsonl sample line', () => {
        const legacy = JSON.parse(
            '{"schema_version":"uc.event.v1","event_id":"evt_5f3a9c2b1d7e4f80","kind":"claude.session.updated",' +
            '"source":"claude-web-driver","subject":"claude:session:abc123","occurred_at":"2026-05-08T14:42:09.000Z",' +
            '"host":"fabios-mac-mini","privacy":"metadata_only","received_at":"2026-05-08T14:42:10.000Z",' +
            '"actor":null,"run_id":null,"trace_id":null,"parent_event_id":null,"priority":50,"ok":true,' +
            '"payload_ref":null,"payload_hash":null,"counts":null,"labels":null,"error":null}'
        );
        const r = validateEnvelope(legacy);
        assert.equal(r.ok, true);
    });
});

describe('validateEmitInput', () => {
    it('accepts a minimal emit input (privacy optional → defaulted later)', () => {
        const r = validateEmitInput({ kind: 'agent.run.completed', source: 'build-agent', subject: 'run:1' });
        assert.equal(r.ok, true);
    });

    it('rejects a missing kind', () => {
        const r = validateEmitInput({ source: 'build-agent', subject: 'run:1' });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.message, /kind/);
    });

    it('rejects an illegal-char source token', () => {
        assert.equal(validateEmitInput({ kind: 'a.b', source: 'bad source', subject: 's' }).ok, false);
    });

    it('rejects an unknown privacy when provided', () => {
        assert.equal(validateEmitInput({ kind: 'a.b', source: 'src', subject: 's', privacy: 'nope' }).ok, false);
    });

    it('rejects a bad payload_hash when provided', () => {
        assert.equal(validateEmitInput({ kind: 'a.b', source: 'src', subject: 's', payload_hash: 'nope' }).ok, false);
    });
});
