// =============================================================================
// gate.test — the PURE decision for the dev overlay. Default ON in dev (browser),
// OFF in prod; `devtools: false` always wins; explicit `true`/options override
// prod (escape hatch); never attaches without a document (SSR/edge/node).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldAttach } from './gate';

describe('devtools gate', () => {
    // the magic default — a dev browser app gets the bubble with zero setup
    it('defaults ON in dev when a document exists', () => {
        assert.equal(shouldAttach({ flag: undefined, prod: false, hasDocument: true }), true);
    });

    // prod builds stay clean by default — no overlay, no chunk fetched
    it('stays OFF in production by default', () => {
        assert.equal(shouldAttach({ flag: undefined, prod: true, hasDocument: true }), false);
    });

    // explicit opt-in is an escape hatch that beats the prod heuristic
    it('explicit true overrides production', () => {
        assert.equal(shouldAttach({ flag: true, prod: true, hasDocument: true }), true);
    });

    // an options object counts as enabled (same as true)
    it('options object counts as enabled', () => {
        assert.equal(shouldAttach({ flag: { position: 'top-left' }, prod: false, hasDocument: true }), true);
    });

    // explicit false always wins, dev or prod
    it('explicit false always wins', () => {
        assert.equal(shouldAttach({ flag: false, prod: false, hasDocument: true }), false);
        assert.equal(shouldAttach({ flag: false, prod: true, hasDocument: true }), false);
    });

    // no DOM, no overlay — SSR, edge, and node never attach even when forced
    it('never attaches without a document', () => {
        assert.equal(shouldAttach({ flag: undefined, prod: false, hasDocument: false }), false);
        assert.equal(shouldAttach({ flag: true, prod: false, hasDocument: false }), false);
    });
});
