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
    const s3 = s3Config(options.s3 ?? raw.storage?.s3 ?? raw.storage?.S3)
    const storageDriver = options.storageDriver
        ?? options.storage_driver
        ?? process.env.UC_STORAGE_DRIVER
        ?? raw.storage?.driver
        ?? (s3 ? 's3' : 'local-dir')

    return {
        projectRoot: root,
        configPath,
        db: resolveConfigPath(root, db),
        contentDir: storageDriver === 's3' || storageDriver === 'inline'
            ? undefined
            : resolveConfigPath(root, contentDir),
        inlineLimit,
        storageDriver,
        s3,
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

function s3Config(input) {
    const config = {
        endpoint: process.env.UC_S3_ENDPOINT,
        bucket: process.env.UC_S3_BUCKET,
        region: process.env.UC_S3_REGION,
        accessKeyId: process.env.UC_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.UC_S3_SECRET_ACCESS_KEY,
        sessionToken: process.env.UC_S3_SESSION_TOKEN,
        prefix: process.env.UC_S3_PREFIX,
        ...(input ?? {})
    }
    const hasConfig = Object.values(config).some(value => value !== undefined && value !== '')
    if (!hasConfig) return undefined
    return {
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region ?? 'auto',
        accessKeyId: config.accessKeyId ?? config.access_key_id,
        secretAccessKey: config.secretAccessKey ?? config.secret_access_key,
        sessionToken: config.sessionToken ?? config.session_token,
        prefix: config.prefix
    }
}
