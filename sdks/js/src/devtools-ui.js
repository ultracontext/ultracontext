const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.uc-layer {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  color: #ededed;
}
.uc-bubble {
  position: fixed;
  right: 20px;
  top: 20px;
  z-index: 2147483647;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: 1px solid #333;
  background: rgba(10,10,10,.82);
  color: #fff;
  box-shadow: 0 8px 26px rgba(0,0,0,.35);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  cursor: pointer;
}
.uc-bubble:hover { border-color: #666; }
.uc-logo {
  font: 700 16px ui-monospace, SFMono-Regular, Menlo, monospace;
}
.uc-panel {
  position: fixed;
  right: 20px;
  top: 68px;
  z-index: 2147483647;
  width: 340px;
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
    const bubble = el('button', 'uc-bubble')
    bubble.setAttribute('aria-label', 'UltraContext devtools')
    bubble.append(el('span', 'uc-logo', '[•]'))
    const panel = el('div', 'uc-panel')
    panel.hidden = true
    layer.append(bubble, panel)
    shadow.append(layer)
    document.body.append(host)

    bubble.addEventListener('click', () => {
        panel.hidden = !panel.hidden
        if (!panel.hidden) void renderList()
    })

    async function renderList() {
        panel.replaceChildren(header('UltraContext', renderList))
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
        try {
            const detail = await uc.get(id)
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
        }
    }
}

async function listContexts(uc) {
    const result = await uc.get()
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
