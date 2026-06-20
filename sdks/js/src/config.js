import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const PROJECT_CONFIG_FILE = 'ultracontext.json'
const DEFAULT_INLINE_LIMIT = 64 * 1024

export async function loadProjectConfig(options = {}) {
    const configPath = options.configPath
        ? resolve(options.configPath)
        : findProjectConfig(options.projectRoot ?? options.cwd ?? process.cwd())

    if (!configPath) {
        throw new Error(`UltraContext project config not found. Run 'uc init' first.`)
    }

    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    const root = dirname(configPath)
    const db = options.db
        ?? process.env.UC_DB
        ?? raw.db
        ?? '.ultracontext/ultracontext.db'
    const contentDir = options.contentDir
        ?? process.env.UC_CONTENT_DIR
        ?? raw.storage?.contentDir
        ?? raw.storage?.content_dir
        ?? '.ultracontext/blobs'
    const inlineLimit = numberOption(
        options.inlineLimit
            ?? process.env.UC_INLINE_LIMIT
            ?? raw.storage?.inlineLimit
            ?? raw.storage?.inline_limit
            ?? DEFAULT_INLINE_LIMIT,
        'inlineLimit'
    )

    return {
        projectRoot: root,
        configPath,
        db: resolveConfigPath(root, db),
        contentDir: resolveConfigPath(root, contentDir),
        inlineLimit,
        raw
    }
}

export function findProjectConfig(start = process.cwd()) {
    let dir = resolve(start)
    while (true) {
        const candidate = join(dir, PROJECT_CONFIG_FILE)
        if (existsSync(candidate)) return candidate

        const legacy = join(dir, '.ultracontext', 'config.json')
        if (existsSync(legacy)) return legacy

        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

function resolveConfigPath(root, value) {
    return isAbsolute(value) ? value : resolve(root, value)
}

function numberOption(value, name) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`UltraContext config ${name} must be a non-negative number`)
    }
    return parsed
}
