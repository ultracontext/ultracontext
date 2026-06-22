const SIZE = 40
const PADDING = 20
const PANEL_W = 340
const DRAG_THRESHOLD = 4

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384" fill="currentColor" aria-hidden="true"><g transform="translate(0, 57)"><g transform="translate(-6.826197, 216.610709)"><path d="M 41.3125 24.296875 L 41.3125 -183.359375 L 103.171875 -183.359375 L 103.171875 -157.953125 L 68.921875 -157.953125 L 68.921875 -1.109375 L 103.171875 -1.109375 L 103.171875 24.296875 Z M 41.3125 24.296875"/></g><g transform="translate(125.723537, 216.610709)"><path d="M 36.671875 -78.421875 C 36.671875 -82.691406 37.40625 -86.59375 38.875 -90.125 C 40.351562 -93.664062 42.414062 -96.722656 45.0625 -99.296875 C 47.71875 -101.878906 50.847656 -103.90625 54.453125 -105.375 C 58.066406 -106.851562 62.007812 -107.59375 66.28125 -107.59375 C 70.550781 -107.59375 74.488281 -106.851562 78.09375 -105.375 C 81.707031 -103.90625 84.835938 -101.878906 87.484375 -99.296875 C 90.140625 -96.722656 92.203125 -93.664062 93.671875 -90.125 C 95.140625 -86.59375 95.875 -82.691406 95.875 -78.421875 C 95.875 -74.296875 95.140625 -70.46875 93.671875 -66.9375 C 92.203125 -63.40625 90.140625 -60.347656 87.484375 -57.765625 C 84.835938 -55.191406 81.707031 -53.203125 78.09375 -51.796875 C 74.488281 -50.398438 70.550781 -49.703125 66.28125 -49.703125 C 62.007812 -49.703125 58.066406 -50.398438 54.453125 -51.796875 C 50.847656 -53.203125 47.71875 -55.191406 45.0625 -57.765625 C 42.414062 -60.347656 40.351562 -63.40625 38.875 -66.9375 C 37.40625 -70.46875 36.671875 -74.296875 36.671875 -78.421875 Z M 36.671875 -78.421875"/></g><g transform="translate(258.273272, 216.610709)"><path d="M 29.828125 24.296875 L 29.828125 -1.109375 L 64.0625 -1.109375 L 64.0625 -157.953125 L 29.828125 -157.953125 L 29.828125 -183.359375 L 91.90625 -183.359375 L 91.90625 24.296875 Z M 29.828125 24.296875"/></g></g></svg>`

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.uc-layer {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  color: #ededed;
}
.uc-wrap {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2147483647;
  will-change: transform;
}
.uc-bubble {
  width: ${SIZE}px;
  height: ${SIZE}px;
  border-radius: 999px;
  border: 1px solid #333;
  background: rgba(10,10,10,.82);
  color: #fff;
  box-shadow: 0 8px 26px rgba(0,0,0,.35);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.uc-bubble:hover { border-color: #666; }
.uc-bubble:active { cursor: grabbing; }
.uc-logo {
  width: 18px;
  height: 18px;
  display: block;
}
.uc-panel {
  position: fixed;
  z-index: 2147483647;
  width: ${PANEL_W}px;
  max-height: min(620px, calc(100vh - 92px));
  overflow: auto;
  border-radius: 12px;
  border: 1px solid #2e2e2e;
  background: #0a0a0a;
  box-shadow: 0 18px 60px rgba(0,0,0,.5);
}
.uc-panel[hidden] { display: none; }
.uc-head, .uc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #1f1f1f;
}
.uc-foot {
  border-top: 1px solid #1f1f1f;
  border-bottom: 0;
  color: #777;
  font-size: 11px;
}
.uc-title {
  border: 0;
  padding: 0;
  color: #ededed;
  background: transparent;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.uc-actions { display: flex; gap: 6px; }
.uc-icon {
  border: 0;
  border-radius: 6px;
  padding: 2px 6px;
  background: transparent;
  color: #888;
  font: inherit;
  cursor: pointer;
}
.uc-icon:hover { background: #1d1d1d; color: #fff; }
.uc-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
}
.uc-label { color: #777; }
.uc-value {
  min-width: 0;
  color: #ededed;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uc-divider { border-top: 1px solid #1f1f1f; }
.uc-context {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  border: 0;
  padding: 10px 12px;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.uc-context:hover { background: #161616; }
.uc-id { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.uc-when { color: #666; font-size: 11px; white-space: nowrap; }
.uc-empty, .uc-error { padding: 14px 12px; color: #888; }
.uc-error { color: #ff8f8f; }
.uc-full-id {
  padding: 8px 12px;
  color: #aaa;
  font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.uc-message { border-top: 1px solid #1f1f1f; }
.uc-message summary {
  padding: 9px 12px;
  cursor: pointer;
}
.uc-message pre {
  margin: 0;
  padding: 0 12px 12px;
  color: #aaa;
  white-space: pre-wrap;
  word-break: break-word;
  font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
}
`

export function mountDevtools(uc, info, options = {}) {
    const host = document.createElement('div')
    host.setAttribute('data-ultracontext-devtools', '')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE
    shadow.append(style)

    const layer = el('div', 'uc-layer')
    const wrap = el('div', 'uc-wrap')
    const bubble = el('button', 'uc-bubble')
    bubble.setAttribute('aria-label', 'UltraContext devtools')
    bubble.innerHTML = LOGO_SVG
    bubble.firstElementChild?.classList.add('uc-logo')
    const panel = el('div', 'uc-panel')
    panel.hidden = true
    wrap.append(bubble)
    layer.append(wrap, panel)
    shadow.append(layer)
    document.body.append(host)

    const position = {
        x: window.innerWidth - SIZE - PADDING,
        y: PADDING
    }
    let press = null
    let dragging = false

    applyPosition()

    bubble.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        bubble.setPointerCapture(event.pointerId)
        press = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: position.x,
            startY: position.y
        }
        dragging = false
    })

    bubble.addEventListener('pointermove', event => {
        if (!press || !bubble.hasPointerCapture(event.pointerId)) return
        const dx = event.clientX - press.x
        const dy = event.clientY - press.y
        if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            dragging = true
            panel.hidden = true
        }
        if (!dragging) return
        position.x = clamp(press.startX + dx, PADDING, window.innerWidth - SIZE - PADDING)
        position.y = clamp(press.startY + dy, PADDING, window.innerHeight - SIZE - PADDING)
        applyPosition()
    })

    bubble.addEventListener('pointerup', event => {
        if (!press || !bubble.hasPointerCapture(event.pointerId)) return
        bubble.releasePointerCapture(event.pointerId)
        press = null

        if (!dragging) {
            panel.hidden = !panel.hidden
            if (!panel.hidden) {
                placePanel()
                void renderList()
            }
            return
        }

        dragging = false
        position.x = nearestEdgeX(position.x)
        applyPosition()
        if (!panel.hidden) placePanel()
    })

    bubble.addEventListener('pointercancel', event => {
        if (bubble.hasPointerCapture(event.pointerId)) {
            bubble.releasePointerCapture(event.pointerId)
        }
        press = null
        dragging = false
    })

    window.addEventListener('resize', onResize)

    function applyPosition() {
        wrap.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
    }

    function placePanel() {
        const rightSide = position.x + SIZE / 2 > window.innerWidth / 2
        const left = rightSide
            ? position.x - PANEL_W - 12
            : position.x + SIZE + 12
        panel.style.left = `${clamp(left, PADDING, window.innerWidth - PANEL_W - PADDING)}px`
        panel.style.top = `${clamp(position.y, PADDING, window.innerHeight - PADDING)}px`
        panel.style.transformOrigin = rightSide ? 'top right' : 'top left'
        requestAnimationFrame(() => {
            const overflow = position.y + panel.offsetHeight + PADDING - window.innerHeight
            if (overflow > 0) {
                panel.style.top = `${Math.max(PADDING, position.y - overflow)}px`
            }
        })
    }

    function onResize() {
        position.x = clamp(position.x, PADDING, window.innerWidth - SIZE - PADDING)
        position.y = clamp(position.y, PADDING, window.innerHeight - SIZE - PADDING)
        applyPosition()
        if (!panel.hidden) placePanel()
    }

    async function renderList() {
        panel.replaceChildren(header('UltraContext', renderList))
        placePanel()
        try {
            const rows = await listContexts(uc)
            panel.append(
                infoRow('Mode', info.mode),
                infoRow('Endpoint', info.db),
                infoRow('Contexts', String(rows.length)),
                el('div', 'uc-divider')
            )
            if (rows.length === 0) {
                panel.append(el('div', 'uc-empty', 'No contexts yet'))
            }
            for (const row of rows) {
                panel.append(contextRow(row))
            }
            panel.append(footer())
        } catch (error) {
            panel.append(el('div', 'uc-error', `Failed to load: ${error.message}`))
        }
    }

    async function renderDetail(id) {
        panel.replaceChildren(header('‹ Context', renderList, () => renderDetail(id)))
        placePanel()
        try {
            const session = await uc.sessions.get(id)
            const detail = await session.context.get()
            const messages = detail.data ?? []
            panel.append(
                el('div', 'uc-full-id', id),
                infoRow('Version', String(detail.version ?? 'latest')),
                infoRow('Messages', String(messages.length))
            )
            if (messages.length === 0) {
                panel.append(el('div', 'uc-empty', 'No messages'))
            }
            for (const message of messages) {
                panel.append(messageRow(message))
            }
            panel.append(footer())
        } catch (error) {
            panel.append(el('div', 'uc-error', `Failed to inspect: ${error.message}`))
        }
    }

    function contextRow(row) {
        const button = el('button', 'uc-context')
        button.append(el('span', 'uc-id', shortId(row.id)), el('span', 'uc-when', when(row.created_at)))
        button.addEventListener('click', () => void renderDetail(row.id))
        return button
    }

    function messageRow(message) {
        const details = document.createElement('details')
        details.className = 'uc-message'
        const summary = document.createElement('summary')
        summary.textContent = messagePreview(message)
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(message, null, 2)
        details.append(summary, pre)
        return details
    }

    function header(title, onTitle, onRefresh = onTitle) {
        const head = el('div', 'uc-head')
        const titleButton = el('button', 'uc-title', title)
        titleButton.addEventListener('click', () => void onTitle())
        const actions = el('div', 'uc-actions')
        const refresh = el('button', 'uc-icon', '⟳')
        refresh.setAttribute('aria-label', 'Refresh')
        refresh.addEventListener('click', () => void onRefresh())
        const close = el('button', 'uc-icon', '×')
        close.setAttribute('aria-label', 'Close')
        close.addEventListener('click', () => {
            panel.hidden = true
        })
        actions.append(refresh, close)
        head.append(titleButton, actions)
        return head
    }

    function footer() {
        const foot = el('div', 'uc-foot')
        foot.append(el('span', undefined, 'control what agents see.'))
        if (options.destroyable !== false) {
            const close = el('button', 'uc-icon', 'Hide')
            close.addEventListener('click', () => {
                panel.hidden = true
                host.remove()
            })
            foot.append(close)
        }
        return foot
    }

    return {
        destroy() {
            host.remove()
            window.removeEventListener('resize', onResize)
        }
    }
}

async function listContexts(uc) {
    const result = await uc.sessions.list()
    return [...(result.data ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

function infoRow(label, value) {
    const row = el('div', 'uc-row')
    row.append(el('span', 'uc-label', label), el('span', 'uc-value', value))
    return row
}

function messagePreview(message) {
    if (typeof message?.content === 'string') return message.content.replace(/\s+/g, ' ').slice(0, 90)
    if (Array.isArray(message?.parts)) {
        const text = message.parts
            .filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join(' ')
            .replace(/\s+/g, ' ')
        if (text) return text.slice(0, 90)
    }
    return message?.role ? `${message.role} message` : 'message'
}

function shortId(id) {
    return id.length > 20 ? `${id.slice(0, 20)}…` : id
}

function when(value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString()
}

function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

function nearestEdgeX(x) {
    const min = PADDING
    const max = window.innerWidth - SIZE - PADDING
    return Math.abs(x - min) <= Math.abs(x - max) ? min : max
}

function clamp(value, min, max) {
    if (max < min) return min
    return Math.min(Math.max(value, min), max)
}
