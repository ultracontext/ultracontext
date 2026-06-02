// =============================================================================
// context-id.test — requireContextId precedence: explicit arg > $UC_CONTEXT >
// throw. No cwd default anywhere; every targeted verb runs through this helper.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { requireContextId } from './context-id';

// -- precedence ---------------------------------------------------------------

describe('requireContextId', () => {
    // an explicit id arg wins over everything, env included
    it('prefers the explicit id arg over UC_CONTEXT', () => {
        const id = requireContextId('ctx_arg', { UC_CONTEXT: 'ctx_env' });
        assert.equal(id, 'ctx_arg');
    });

    // no arg → fall back to the UC_CONTEXT env var
    it('falls back to UC_CONTEXT when no id arg is given', () => {
        const id = requireContextId(undefined, { UC_CONTEXT: 'ctx_env' });
        assert.equal(id, 'ctx_env');
    });

    // neither arg nor env → a clear, actionable error (no cwd magic)
    it('throws a clear error when neither arg nor UC_CONTEXT is set', () => {
        assert.throws(
            () => requireContextId(undefined, {}),
            /no context — pass an id or set UC_CONTEXT/,
        );
    });
});
