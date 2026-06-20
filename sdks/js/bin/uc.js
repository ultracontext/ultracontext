#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const current = fileURLToPath(import.meta.url)
const extension = process.platform === 'win32' ? '.exe' : ''
const platformBinary = `uc-${process.platform}-${process.arch}${extension}`
const args = process.argv.slice(2)

const candidates = [
    process.env.ULTRACONTEXT_CLI,
    join(here, platformBinary),
    join(here, `uc${extension}`),
    findOnPath('uc'),
].filter(Boolean)

const packagedCli = candidates.find((candidate) => existsSync(candidate) && !sameFile(candidate, current))
let tempDir = null
let exitCode = 0

try {
    const cli = packagedCli ?? await downloadReleaseCli()
    const result = spawnSync(cli, args, { stdio: 'inherit', env: bootstrapEnv() })

    if (result.error) {
        console.error(result.error.message)
        exitCode = 1
    } else {
        exitCode = result.status ?? 0
    }
} catch (error) {
    console.error(`internal: ${error.message}`)
    exitCode = 1
} finally {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
    }
}

process.exit(exitCode)

function findOnPath(command) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (!dir) continue
        const candidate = resolve(dir, `${command}${extension}`)
        if (existsSync(candidate)) return candidate
    }
    return null
}

function sameFile(a, b) {
    try {
        return realpathSync(a) === realpathSync(b)
    } catch {
        return false
    }
}

function bootstrapEnv() {
    const env = { ...process.env }
    const pkg = packageInfo()

    if (!env.UC_NPM_PACKAGE_NAME && pkg?.name) {
        env.UC_NPM_PACKAGE_NAME = pkg.name
    }
    if (!env.UC_NPM_SPEC && pkg?.name && pkg?.version) {
        env.UC_NPM_SPEC = `${pkg.name}@${pkg.version}`
    }

    return env
}

function packageInfo() {
    try {
        return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    } catch {
        return null
    }
}

async function downloadReleaseCli() {
    const target = releaseTarget()
    const repo = process.env.UC_REPO ?? 'https://github.com/ultracontext/ultracontext'
    const version = process.env.UC_VERSION ?? 'latest'
    const base = version === 'latest'
        ? `${repo}/releases/latest/download`
        : `${repo}/releases/download/${version}`
    const url = `${base}/uc-${target}.tar.gz`

    tempDir = mkdtempSync(join(tmpdir(), 'ultracontext-npx-'))
    const archive = join(tempDir, 'uc.tar.gz')

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`failed to download ${url}: HTTP ${response.status}`)
    }

    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))

    const tar = spawnSync('tar', ['-xzf', archive, '-C', tempDir], { stdio: 'ignore' })
    if (tar.error) {
        throw new Error(`failed to run tar: ${tar.error.message}`)
    }
    if (tar.status !== 0) {
        throw new Error(`failed to extract ${url}`)
    }

    const cli = findExtractedCli(tempDir)
    chmodSync(cli, 0o755)
    return cli
}

function releaseTarget() {
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin'
    if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin'
    if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-gnu'
    if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu'
    throw new Error(`unsupported platform for ultracontext CLI download: ${process.platform}/${process.arch}`)
}

function findExtractedCli(dir) {
    const result = spawnSync('find', [dir, '-type', 'f', '-name', `uc${extension}`], { encoding: 'utf8' })
    if (result.error) {
        throw new Error(`failed to inspect release archive: ${result.error.message}`)
    }

    const [cli] = result.stdout.trim().split('\n').filter(Boolean)
    if (!cli) {
        throw new Error('release archive did not contain uc')
    }
    return cli
}
