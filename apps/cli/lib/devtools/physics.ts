// =============================================================================
// physics — the PURE math behind the draggable bubble (ported from the Vercel
// snap-button pattern): iOS momentum projection, nearest-edge snapping,
// viewport clamping, and the drop-zone rect hit test. No DOM here — ui.ts
// applies these over pointer events; the spring animator lives there too.
// =============================================================================

// -- momentum -------------------------------------------------------------------

// where a fling would coast to — the iOS UIScrollView deceleration formula
export function project(initialVelocity: number, decelerationRate = 0.998): number {
    return ((initialVelocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// -- snapping ---------------------------------------------------------------------

// the x of the nearest horizontal edge (left/right, inset by padding) for a
// bubble of `size` whose projected left-x is `x` in a viewport `viewportWidth` wide
export function nearestEdgeX(x: number, viewportWidth: number, size: number, padding: number): number {
    const minX = padding;
    const maxX = viewportWidth - size - padding;
    return Math.abs(x - minX) <= Math.abs(x - maxX) ? minX : maxX;
}

// -- clamping ---------------------------------------------------------------------

export function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
}

// -- hit test ---------------------------------------------------------------------

// a rect in viewport coordinates (subset of DOMRect, plain for testability)
export type Rect = { left: number; right: number; top: number; bottom: number };

// do two rects overlap? `padding` widens the hit area (magnet feel)
export function intersects(a: Rect, b: Rect, padding = 0): boolean {
    return !(
        a.right + padding < b.left ||
        a.left - padding > b.right ||
        a.bottom + padding < b.top ||
        a.top - padding > b.bottom
    );
}
