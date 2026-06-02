// =============================================================================
// output.test — pipe-aware decision (json vs human) + data goes to stdout,
// status/errors go to stderr. Streams + tty are injectable for testability.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldJson, emit, status, outputError } from './output';

// -- capture helper -----------------------------------------------------------

// a writable-like sink that records everything written to it
function sink() {
    const chunks: string[] = [];
    return { write: (s: string) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// -- mode decision ------------------------------------------------------------

describe('shouldJson', () => {
    // explicit --json always wins, regardless of tty
    it('is true when --json is set (even on a TTY)', () => {
        assert.equal(shouldJson({ json: true }, { isTTY: true }), true);
    });

    // piped stdout (not a TTY) implies machine mode
    it('is true when stdout is not a TTY', () => {
        assert.equal(shouldJson({}, { isTTY: false }), true);
    });

    // interactive TTY without --json → human mode
    it('is false on an interactive TTY without --json', () => {
        assert.equal(shouldJson({}, { isTTY: true }), false);
    });
});

// -- data output --------------------------------------------------------------

describe('emit', () => {
    // machine mode writes a single JSON line to stdout (not stderr)
    it('writes JSON to stdout in machine mode', () => {
        const out = sink();
        const errs = sink();

        emit({ id: 'ctx_1' }, { json: true }, { stdout: out, stderr: errs, isTTY: false });

        assert.equal(out.text(), '{"id":"ctx_1"}\n');
        assert.equal(errs.text(), '');
    });

    // human mode renders via the formatter, still to stdout
    it('writes human text to stdout via the formatter', () => {
        const out = sink();
        const errs = sink();

        emit({ id: 'ctx_1' }, { human: (d) => 'id=' + (d as { id: string }).id }, { stdout: out, stderr: errs, isTTY: true });

        assert.equal(out.text(), 'id=ctx_1\n');
        assert.equal(errs.text(), '');
    });
});

// -- status + errors ----------------------------------------------------------

describe('status + outputError', () => {
    // status lines go to stderr and never pollute stdout
    it('writes status to stderr only', () => {
        const out = sink();
        const errs = sink();

        status('working…', { stdout: out, stderr: errs, isTTY: true });

        assert.equal(out.text(), '');
        assert.ok(errs.text().includes('working'));
    });

    // outputError returns exit 1 for a normal failure, writing to stderr
    it('returns exit 1 and writes the message to stderr', () => {
        const errs = sink();
        const code = outputError(new Error('boom'), { stderr: errs });

        assert.equal(code, 1);
        assert.ok(errs.text().includes('boom'));
    });

    // a cancel marker maps to exit code 130
    it('returns exit 130 on a cancel marker', () => {
        const errs = sink();
        const code = outputError({ code: 'cancel' }, { stderr: errs });

        assert.equal(code, 130);
    });

    // a machine-mode error emits a JSON error envelope to stderr
    it('emits a JSON error envelope in machine mode', () => {
        const errs = sink();
        outputError(new Error('nope'), { stderr: errs, json: true });

        const parsed = JSON.parse(errs.text());
        assert.equal(parsed.error, 'nope');
    });
});
