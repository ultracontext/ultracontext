const MARKER = '__ultracontextDevtools__'

export function maybeAttachDevtools(uc, info, flag) {
    if (!shouldAttach(flag)) return
    const global = globalThis
    if (global[MARKER]) return
    global[MARKER] = true

    import('./devtools-ui.js')
        .then(({ mountDevtools }) => {
            const handle = mountDevtools(uc, info, typeof flag === 'object' ? flag : {})
            global[MARKER] = handle
        })
        .catch(() => {
            delete global[MARKER]
        })
}

function shouldAttach(flag) {
    if (typeof document === 'undefined') return false
    if (flag === false) return false
    if (flag !== undefined) return true
    return !isProd()
}

function isProd() {
    try {
        return process.env.NODE_ENV === 'production'
    } catch {
        return false
    }
}
