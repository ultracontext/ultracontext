// =============================================================================
// physics.test — the PURE math behind the draggable bubble: iOS momentum
// projection, nearest-edge snapping, viewport clamping, and rect intersection
// (the drop-zone hit test). No DOM, no timers — fully deterministic.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { project, nearestEdgeX, clamp, intersects } from './physics';

describe('devtools physics — project', () => {
    // zero velocity travels nowhere
    it('projects zero velocity to zero distance', () => {
        assert.equal(project(0), 0);
    });

    // the iOS UIScrollView formula: (v/1000) * rate / (1 - rate)
    it('projects velocity with the iOS deceleration rate', () => {
        assert.ok(Math.abs(project(1000) - 499) < 1);
    });

    // direction is preserved
    it('keeps the sign of the velocity', () => {
        assert.ok(project(-1000) < 0);
    });
});

describe('devtools physics — nearestEdgeX', () => {
    // viewport 1000, bubble 40, padding 20 → edges at 20 and 940
    it('snaps to the left edge when nearer', () => {
        assert.equal(nearestEdgeX(100, 1000, 40, 20), 20);
    });

    it('snaps to the right edge when nearer', () => {
        assert.equal(nearestEdgeX(800, 1000, 40, 20), 940);
    });

    // dead center (480 vs edges 20/940) → right is nearer from 500
    it('breaks toward the nearer edge from center-ish positions', () => {
        assert.equal(nearestEdgeX(700, 1000, 40, 20), 940);
        assert.equal(nearestEdgeX(200, 1000, 40, 20), 20);
    });
});

describe('devtools physics — clamp', () => {
    it('clamps below, inside, and above', () => {
        assert.equal(clamp(-5, 0, 10), 0);
        assert.equal(clamp(5, 0, 10), 5);
        assert.equal(clamp(15, 0, 10), 10);
    });
});

describe('devtools physics — intersects', () => {
    const zone = { left: 100, right: 200, top: 100, bottom: 200 };

    it('detects overlap', () => {
        assert.equal(intersects({ left: 150, right: 190, top: 150, bottom: 190 }, zone), true);
    });

    it('detects separation on every side', () => {
        assert.equal(intersects({ left: 0, right: 50, top: 150, bottom: 190 }, zone), false);
        assert.equal(intersects({ left: 250, right: 300, top: 150, bottom: 190 }, zone), false);
        assert.equal(intersects({ left: 150, right: 190, top: 0, bottom: 50 }, zone), false);
        assert.equal(intersects({ left: 150, right: 190, top: 250, bottom: 300 }, zone), false);
    });

    // padding widens the hit area (magnet feel before true overlap)
    it('honors the padding margin', () => {
        assert.equal(intersects({ left: 210, right: 250, top: 150, bottom: 190 }, zone, 15), true);
    });
});
