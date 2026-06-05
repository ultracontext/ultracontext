// =============================================================================
// ui — the overlay's DOM layer, a VANILLA port of the Vercel snap-button feel
// (framer-motion behavior, zero deps): a draggable bubble with iOS momentum
// projection that springs onto the nearest side edge, a bottom drop-zone that
// closes the overlay for the session, a hover tooltip, and the contexts panel
// anchored to whichever side the bubble sits on. Lives in a SHADOW ROOT so
// host-app CSS can never leak in (or out). Reached ONLY via the lazy import in
// attach.ts, so these bytes are never fetched in production. Read-only + flush.
// =============================================================================

import type { UltraContext } from '../sdk/ultracontext';
import type { DevtoolsInfo, DevtoolsPosition } from './gate';
import { listContexts, inspectContext, clearAll, messageRole, messageText, type DevtoolsContextRow } from './model';
import { project, nearestEdgeX, clamp, intersects } from './physics';

// -- geometry -------------------------------------------------------------------

const SIZE = 40;          // bubble diameter (size-10)
const PADDING = 20;       // viewport inset the bubble snaps to
const PANEL_W = 300;      // panel width
const DRAG_THRESHOLD = 4; // px of travel before a press becomes a drag

// -- styles ---------------------------------------------------------------------

// the whole overlay skin — dark, rounded, system font, isolated in the shadow root
const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; color: #ededed;
    }

    /* -- bubble ------------------------------------------------------------- */
    .wrap {
        position: fixed; left: 0; top: 0; z-index: 2147483647;
        will-change: transform;
        animation: uc-pop 200ms ease-out;
    }
    .wrap.bye {
        transition: opacity 250ms ease, filter 250ms ease, margin-top 250ms ease;
        opacity: 0; filter: blur(4px); margin-top: 20px;
    }
    .bubble {
        width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
        background: rgba(10, 10, 10, 0.8); backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid #333; cursor: grab; touch-action: none;
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35); position: relative;
        user-select: none; -webkit-user-select: none;
    }
    /* the [•] brand mark — inline SVG, so it renders identically everywhere */
    .bubble svg { width: 18px; height: 18px; display: block; }
    .bubble:hover { border-color: #555; }
    .bubble:active { cursor: grabbing; }
    /* -- drop zone ---------------------------------------------------------- */
    .zone {
        position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
        z-index: 2147483646; width: 320px; height: 120px;
        display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        animation: uc-rise 250ms ease-out;
    }
    .zone .ring {
        width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
        background: #0a0a0a; outline: 1px solid #2e2e2e;
        display: flex; align-items: center; justify-content: center;
        color: #ededed; font-size: 22px; font-weight: 200;
        transition: outline-color 150ms ease 150ms;
    }
    .zone.hot .ring { outline-color: #ededed; }
    .zone .hint {
        margin-top: 14px; font-size: 12px; color: #ededed; opacity: 0.4;
        transition: color 150ms ease 150ms, opacity 150ms ease 150ms;
    }
    .zone.hot .hint { color: #ededed; opacity: 1; }

    /* -- panel -------------------------------------------------------------- */
    .panel {
        position: fixed; z-index: 2147483647;
        width: ${PANEL_W}px; max-height: 70vh; overflow: auto;
        background: #0a0a0a; border: 1px solid #2e2e2e; border-radius: 16px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.5);
        opacity: 0; transform: scale(0.96); transition: opacity 130ms ease, transform 130ms ease;
        scrollbar-width: thin; scrollbar-color: #333 transparent;
    }

    /* -- scrollbar — thin gray thumb, no track, inset off the rounded edge -- */
    .panel::-webkit-scrollbar { width: 10px; }
    .panel::-webkit-scrollbar-track { background: transparent; }
    .panel::-webkit-scrollbar-thumb {
        background: #333; border-radius: 5px;
        border: 3px solid transparent; background-clip: padding-box;
    }
    .panel::-webkit-scrollbar-thumb:hover { background-color: #555; }
    .panel.show { opacity: 1; transform: scale(1); }
    .head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-bottom: 1px solid #1f1f1f; font-weight: 600;
    }
    .actions { display: flex; gap: 8px; }
    .iconbtn {
        background: none; border: none; color: #888; cursor: pointer;
        font-size: 14px; padding: 2px 4px; border-radius: 6px; font-family: inherit;
    }
    .iconbtn:hover { color: #fff; background: #1f1f1f; }
    .row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 14px; gap: 12px;
    }
    .row .label { color: #888; }
    .row .value { color: #ededed; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .divider { border-top: 1px solid #1f1f1f; }
    .ctx {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 14px; gap: 12px; cursor: pointer; width: 100%;
        background: none; border: none; color: inherit; font: inherit; text-align: left;
        border-radius: 10px;
    }
    .ctx:hover { background: #161616; }
    .ctx .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .ctx .when { color: #666; font-size: 11px; flex-shrink: 0; }
    .empty, .error { padding: 14px; color: #888; }
    .full-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
        padding: 8px 14px; color: #aaa; word-break: break-all;
    }
    pre {
        margin: 0; padding: 10px 14px; font-size: 11px; color: #d4d4d4;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap; word-break: break-word;
    }

    /* -- messages (detail view) ---------------------------------------------- */
    .msg { border-bottom: 1px solid #1f1f1f; }
    .msg:last-of-type { border-bottom: none; }
    .msg-head {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 8px 14px; background: none; border: none; color: inherit;
        font: inherit; text-align: left; cursor: pointer;
    }
    .msg-head:hover { background: #161616; }
    .role {
        flex-shrink: 0; font-size: 10px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.04em; padding: 1px 6px; border-radius: 6px;
        background: #262626; color: #aaa;
    }
    .role.user { background: #ededed; color: #0a0a0a; }
    .role.assistant { background: #333; color: #ededed; }
    .msg-preview {
        flex: 1; min-width: 0; font-size: 12px; color: #d4d4d4;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .msg-preview.muted { color: #666; font-style: italic; }
    .chev { flex-shrink: 0; color: #555; font-size: 9px; transition: transform 130ms ease; }
    .msg.open .chev { transform: rotate(90deg); }
    .msg-body { display: none; }
    .msg.open .msg-body { display: block; }
    .msg-body pre { padding-top: 0; color: #888; }
    .foot {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 14px; border-top: 1px solid #1f1f1f; color: #666; font-size: 11px;
    }
    .foot button { font-size: 11px; }

    /* -- keyframes ---------------------------------------------------------- */
    @keyframes uc-pop { from { opacity: 0; scale: 0; } to { opacity: 1; scale: 1; } }
    @keyframes uc-rise { from { opacity: 0; translate: 0 20px; } to { opacity: 1; translate: 0 0; } }
`;

// -- brand mark -------------------------------------------------------------------

// the [•] logo as inline SVG (uc.svg, fills swapped to currentColor) — font-proof
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384" fill="currentColor" aria-hidden="true"><g transform="translate(0, 57)"><g transform="translate(-6.826197, 216.610709)"><path d="M 41.3125 24.296875 L 41.3125 -183.359375 L 103.171875 -183.359375 L 103.171875 -157.953125 L 68.921875 -157.953125 L 68.921875 -1.109375 L 103.171875 -1.109375 L 103.171875 24.296875 Z M 41.3125 24.296875"/></g><g transform="translate(125.723537, 216.610709)"><path d="M 36.671875 -78.421875 C 36.671875 -82.691406 37.40625 -86.59375 38.875 -90.125 C 40.351562 -93.664062 42.414062 -96.722656 45.0625 -99.296875 C 47.71875 -101.878906 50.847656 -103.90625 54.453125 -105.375 C 58.066406 -106.851562 62.007812 -107.59375 66.28125 -107.59375 C 70.550781 -107.59375 74.488281 -106.851562 78.09375 -105.375 C 81.707031 -103.90625 84.835938 -101.878906 87.484375 -99.296875 C 90.140625 -96.722656 92.203125 -93.664062 93.671875 -90.125 C 95.140625 -86.59375 95.875 -82.691406 95.875 -78.421875 C 95.875 -74.296875 95.140625 -70.46875 93.671875 -66.9375 C 92.203125 -63.40625 90.140625 -60.347656 87.484375 -57.765625 C 84.835938 -55.191406 81.707031 -53.203125 78.09375 -51.796875 C 74.488281 -50.398438 70.550781 -49.703125 66.28125 -49.703125 C 62.007812 -49.703125 58.066406 -50.398438 54.453125 -51.796875 C 50.847656 -53.203125 47.71875 -55.191406 45.0625 -57.765625 C 42.414062 -60.347656 40.351562 -63.40625 38.875 -66.9375 C 37.40625 -70.46875 36.671875 -74.296875 36.671875 -78.421875 Z M 36.671875 -78.421875"/></g><g transform="translate(258.273272, 216.610709)"><path d="M 29.828125 24.296875 L 29.828125 -1.109375 L 64.0625 -1.109375 L 64.0625 -157.953125 L 29.828125 -157.953125 L 29.828125 -183.359375 L 91.90625 -183.359375 L 91.90625 24.296875 Z M 29.828125 24.296875"/></g></g></svg>`;

// -- helpers ----------------------------------------------------------------------

// tiny element factory (class + text), keeps the render code flat
function el(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// a label/value info row
function infoRow(label: string, value: string): HTMLElement {
    const row = el('div', 'row');
    row.append(el('span', 'label', label), el('span', 'value', value));
    return row;
}

// short display id — enough to recognize, small enough for one line
function shortId(id: string): string {
    return id.length > 18 ? `${id.slice(0, 18)}…` : id;
}

// compact local timestamp for list rows
function when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

// the bubble's initial top-left for a configured corner
function cornerXY(position: DevtoolsPosition): { x: number; y: number } {
    const right = position.endsWith('right');
    const top = position.startsWith('top');
    return {
        x: right ? window.innerWidth - SIZE - PADDING : PADDING,
        y: top ? PADDING : window.innerHeight - SIZE - PADDING,
    };
}

// -- spring ------------------------------------------------------------------------

// rAF spring integrator (stiffness/damping/mass ≈ the framer-motion config);
// returns a cancel function. Used for the post-release edge snap.
function spring(from: number, velocity: number, target: number, onUpdate: (v: number) => void): () => void {
    const k = 350, c = 20, m = 0.3;
    let x = from, v = velocity, last = performance.now(), raf = 0;

    const step = (now: number): void => {
        const dt = Math.min((now - last) / 1000, 0.034);
        last = now;
        v += ((-k * (x - target) - c * v) / m) * dt;
        x += v * dt;
        if (Math.abs(x - target) < 0.1 && Math.abs(v) < 1) {
            onUpdate(target);
            return;
        }
        onUpdate(x);
        raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
}

// -- mount ------------------------------------------------------------------------

// build the overlay and return a destroy handle. All data flows through the
// read-only model over the public facade — local and remote both just work.
export function mountDevtools(uc: UltraContext, info: DevtoolsInfo, position: DevtoolsPosition): { destroy(): void } {
    // host + shadow root — the app's CSS cannot touch anything inside
    const host = document.createElement('div');
    host.setAttribute('data-ultracontext-devtools', '');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.append(style);

    const layer = el('div', 'layer');
    shadow.append(layer);

    // -- bubble -------------------------------------------------------------------

    const wrap = el('div', 'wrap');
    // the uc logo — the real [•] SVG mark, identical in every host app
    const bubble = el('button', 'bubble');
    bubble.innerHTML = LOGO_SVG;
    bubble.setAttribute('aria-label', 'UltraContext devtools');
    wrap.append(bubble);
    layer.append(wrap);

    // -- drop zone (shown while dragging) ----------------------------------------

    const zone = el('div', 'zone');
    const ring = el('div', 'ring', '✕');
    const hint = el('span', 'hint', 'Drop here to close');
    zone.append(ring, hint);

    // -- panel --------------------------------------------------------------------

    const panel = el('div', 'panel');
    panel.hidden = true;
    layer.append(panel);

    // -- bubble position state ----------------------------------------------------

    // raw = where the pointer wants the bubble; vis = what is rendered (chases
    // raw, or the zone ring while magnetized). Springs animate vis after release.
    const raw = cornerXY(position);
    const vis = { ...raw };
    let cancelX: (() => void) | null = null;
    let cancelY: (() => void) | null = null;

    function applyVis(): void {
        wrap.style.transform = `translate3d(${vis.x}px, ${vis.y}px, 0)`;
    }
    applyVis();

    // -- drag machinery -----------------------------------------------------------

    let dragging = false;
    let inZone = false;
    let pressX = 0, pressY = 0, origX = 0, origY = 0;
    let lastT = 0, lastX = 0, lastY = 0, velX = 0, velY = 0;
    let chaseRaf = 0;

    // while dragging, vis chases raw (or the zone ring center when magnetized)
    function chase(): void {
        const target = inZone ? zoneCenter() : raw;
        vis.x += (target.x - vis.x) * 0.5;
        vis.y += (target.y - vis.y) * 0.5;
        applyVis();
        if (dragging) chaseRaf = requestAnimationFrame(chase);
    }

    function zoneCenter(): { x: number; y: number } {
        const r = ring.getBoundingClientRect();
        return { x: r.left, y: r.top };
    }

    function onPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        cancelX?.(); cancelY?.();
        bubble.setPointerCapture(e.pointerId);
        pressX = e.clientX; pressY = e.clientY;
        origX = raw.x; origY = raw.y;
        lastT = e.timeStamp; lastX = e.clientX; lastY = e.clientY;
        velX = 0; velY = 0;
    }

    function onPointerMove(e: PointerEvent): void {
        if (!bubble.hasPointerCapture(e.pointerId)) return;

        // a press becomes a drag after a small travel threshold
        if (!dragging && Math.hypot(e.clientX - pressX, e.clientY - pressY) > DRAG_THRESHOLD) {
            dragging = true;
            wrap.classList.add('dragging');
            hidePanel();
            layer.append(zone);
            chaseRaf = requestAnimationFrame(chase);
        }
        if (!dragging) return;

        // follow the pointer, clamped to the viewport insets
        raw.x = clamp(origX + (e.clientX - pressX), PADDING, window.innerWidth - SIZE - PADDING);
        raw.y = clamp(origY + (e.clientY - pressY), PADDING, window.innerHeight - SIZE - PADDING);

        // smoothed velocity (px/s) for the release momentum
        const dt = Math.max(e.timeStamp - lastT, 1);
        velX = 0.8 * ((e.clientX - lastX) / dt) * 1000 + 0.2 * velX;
        velY = 0.8 * ((e.clientY - lastY) / dt) * 1000 + 0.2 * velY;
        lastT = e.timeStamp; lastX = e.clientX; lastY = e.clientY;

        // magnetize when the bubble overlaps the drop zone
        const b = { left: raw.x, right: raw.x + SIZE, top: raw.y, bottom: raw.y + SIZE };
        inZone = intersects(b, zone.getBoundingClientRect());
        zone.classList.toggle('hot', inZone);
        hint.textContent = inZone ? 'Leave here to close' : 'Drop here to close';
    }

    function onPointerUp(e: PointerEvent): void {
        if (!bubble.hasPointerCapture(e.pointerId)) return;
        bubble.releasePointerCapture(e.pointerId);

        // a non-drag press is a click — toggle the panel
        if (!dragging) {
            togglePanel();
            return;
        }

        dragging = false;
        cancelAnimationFrame(chaseRaf);
        wrap.classList.remove('dragging');
        zone.remove();

        // dropped on the zone → close the overlay for this session
        if (inZone) {
            inZone = false;
            closeForSession();
            return;
        }

        // fling: project the momentum, snap to the nearest side edge
        const projected = raw.x + project(velX);
        raw.x = nearestEdgeX(projected, window.innerWidth, SIZE, PADDING);
        cancelX = spring(vis.x, velX, raw.x, (v) => { vis.x = v; applyVis(); });
        cancelY = spring(vis.y, velY, raw.y, (v) => { vis.y = v; applyVis(); });
    }

    bubble.addEventListener('pointerdown', onPointerDown);
    bubble.addEventListener('pointermove', onPointerMove);
    bubble.addEventListener('pointerup', onPointerUp);

    // keep the bubble inside the viewport when it resizes
    function onResize(): void {
        raw.x = clamp(raw.x, PADDING, window.innerWidth - SIZE - PADDING);
        raw.y = clamp(raw.y, PADDING, window.innerHeight - SIZE - PADDING);
        vis.x = raw.x; vis.y = raw.y;
        applyVis();
    }
    window.addEventListener('resize', onResize);

    // dropped on the zone: fade the bubble out and remove the overlay — the
    // attach marker stays set, so it will not remount until the next page load
    function closeForSession(): void {
        hidePanel();
        wrap.classList.add('bye');
        setTimeout(() => host.remove(), 260);
    }

    // -- panel open/close ---------------------------------------------------------

    function togglePanel(): void {
        if (panel.hidden) {
            panel.hidden = false;
            wrap.classList.add('open');
            placePanel();
            void renderList();
            requestAnimationFrame(() => panel.classList.add('show'));
        } else {
            hidePanel();
        }
    }

    function hidePanel(): void {
        panel.classList.remove('show');
        panel.hidden = true;
        wrap.classList.remove('open');
    }

    // anchor the panel to whichever side of the bubble has room, clamped vertically
    function placePanel(): void {
        const onRightHalf = raw.x + SIZE / 2 > window.innerWidth / 2;
        panel.style.left = onRightHalf ? `${raw.x - PANEL_W - 12}px` : `${raw.x + SIZE + 12}px`;
        panel.style.transformOrigin = onRightHalf ? 'top right' : 'top left';
        panel.style.top = `${raw.y}px`;

        // clamp the bottom edge once the content height is known
        requestAnimationFrame(() => {
            const overflow = raw.y + panel.offsetHeight + PADDING - window.innerHeight;
            if (overflow > 0) panel.style.top = `${Math.max(PADDING, raw.y - overflow)}px`;
        });
    }

    // -- views ----------------------------------------------------------------

    // list view: info rows + the project's contexts, newest first
    async function renderList(): Promise<void> {
        panel.replaceChildren(head('UltraContext', renderList));
        try {
            const rows = await listContexts(uc);
            panel.append(
                infoRow('Mode', info.mode),
                infoRow('DB', info.db),
                infoRow('Contexts', String(rows.length)),
                el('div', 'divider'),
            );

            if (rows.length === 0) {
                panel.append(el('div', 'empty', 'No contexts yet'));
            }
            for (const row of rows) panel.append(ctxRow(row));

            panel.append(foot());
        } catch (err) {
            panel.append(el('div', 'error', `Failed to load contexts: ${(err as Error).message}`));
        }
    }

    // detail view: full id + version + messages as expandable chat rows
    async function renderDetail(id: string): Promise<void> {
        panel.replaceChildren(head('‹ Context', renderList, () => renderDetail(id)));
        try {
            const detail = await inspectContext(uc, id);
            panel.append(el('div', 'full-id', id));
            if (detail.version !== undefined) panel.append(infoRow('Version', String(detail.version)));
            panel.append(infoRow('Messages', String(detail.messages.length)), el('div', 'divider'));

            if (detail.messages.length === 0) panel.append(el('div', 'empty', 'No messages'));
            for (const msg of detail.messages) panel.append(msgRow(msg));

            panel.append(foot());
        } catch (err) {
            panel.append(el('div', 'error', `Failed to load context: ${(err as Error).message}`));
        }
    }

    // one message: role badge + one-line preview; click expands to the raw JSON
    function msgRow(msg: unknown): HTMLElement {
        const role = messageRole(msg);
        const text = messageText(msg);

        const item = el('div', 'msg');
        const headBtn = el('button', 'msg-head');
        const known = ['user', 'assistant'].includes(role);
        headBtn.append(
            el('span', `role${known ? ` ${role}` : ''}`, role),
            el('span', `msg-preview${text ? '' : ' muted'}`, text ? text.replace(/\s+/g, ' ') : 'no text'),
            el('span', 'chev', '▶'),
        );

        // body built lazily on first expand — keeps long contexts cheap to open
        const body = el('div', 'msg-body');
        let built = false;
        headBtn.addEventListener('click', () => {
            if (!built) {
                built = true;
                const pre = el('pre');
                pre.textContent = JSON.stringify(msg, null, 2);
                body.append(pre);
            }
            item.classList.toggle('open');
        });

        item.append(headBtn, body);
        return item;
    }

    // panel header: title (doubles as back in detail), refresh + close actions
    function head(title: string, onTitle: () => void, onRefresh?: () => void): HTMLElement {
        const bar = el('div', 'head');
        const titleBtn = el('button', 'iconbtn', title);
        titleBtn.style.color = '#ededed';
        titleBtn.addEventListener('click', () => void onTitle());

        const actions = el('div', 'actions');
        const refresh = el('button', 'iconbtn', '⟳');
        refresh.setAttribute('aria-label', 'Refresh');
        refresh.addEventListener('click', () => void (onRefresh ?? onTitle)());
        const close = el('button', 'iconbtn', '✕');
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', hidePanel);
        actions.append(refresh, close);

        bar.append(titleBtn, actions);
        return bar;
    }

    // one clickable context row in the list
    function ctxRow(row: DevtoolsContextRow): HTMLElement {
        const btn = el('button', 'ctx');
        btn.append(el('span', 'id', shortId(row.id)), el('span', 'when', when(row.created_at)));
        btn.addEventListener('click', () => void renderDetail(row.id));
        return btn;
    }

    // footer: package label + actions. Clear wipes EVERY context (two-click
    // confirm); Flush (local only) force-persists the IndexedDB snapshot.
    function foot(): HTMLElement {
        const bar = el('div', 'foot');
        bar.append(el('span', undefined, 'ultracontext'));
        const actions = el('div', 'actions');

        // Clear — destructive, so it asks once: Clear → Sure? → wipe + reload list
        const clear = el('button', 'iconbtn', 'Clear');
        clear.setAttribute('aria-label', 'Delete all contexts');
        let armed = false;
        clear.addEventListener('click', async () => {
            if (!armed) {
                armed = true;
                clear.textContent = 'Sure?';
                clear.style.color = '#fff';
                setTimeout(() => { armed = false; clear.textContent = 'Clear'; clear.style.color = ''; }, 2000);
                return;
            }
            armed = false;
            clear.textContent = '…';
            try {
                await clearAll(uc);
                await uc.flush();
                void renderList();
            } catch {
                clear.textContent = '✕ Failed';
                clear.style.color = '';
                setTimeout(() => { clear.textContent = 'Clear'; }, 1200);
            }
        });
        actions.append(clear);

        // Flush — async + silent, so the outcome shows on the button itself
        if (info.mode === 'local') {
            const flush = el('button', 'iconbtn', 'Flush');
            flush.setAttribute('aria-label', 'Persist local snapshot now');
            flush.addEventListener('click', async () => {
                flush.textContent = '…';
                try {
                    await uc.flush();
                    flush.textContent = '✓ Flushed';
                } catch {
                    flush.textContent = '✕ Failed';
                }
                setTimeout(() => { flush.textContent = 'Flush'; }, 1200);
            });
            actions.append(flush);
        }

        bar.append(actions);
        return bar;
    }

    // -- global events ------------------------------------------------------------

    // Escape closes the panel
    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') hidePanel();
    }
    document.addEventListener('keydown', onKey);

    // clicking anywhere outside the overlay closes the panel — composedPath
    // sees through the shadow root, so inside clicks (bubble/panel) keep it open
    function onOutsidePress(e: PointerEvent): void {
        if (!panel.hidden && !e.composedPath().includes(host)) hidePanel();
    }
    document.addEventListener('pointerdown', onOutsidePress);

    document.body.appendChild(host);
    return {
        destroy() {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onOutsidePress);
            window.removeEventListener('resize', onResize);
            cancelX?.(); cancelY?.();
            cancelAnimationFrame(chaseRaf);
            host.remove();
        },
    };
}
