// =============================================================================
// manifest — driver discovery + parse over the filesystem. A driver is a dir at
// <configDir>/drivers/<name>/ holding a driver.toml (driver-adapter-v1). This
// module is the read side: list every installed manifest, or load one by name.
// The .toml is parsed by smol-toml (the contract is real TOML, never hand-rolled).
// Manifests NEVER hold secrets — error paths report the driver/path, never the
// manifest body, so a malformed file can't leak its contents to a log.
// =============================================================================

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { configDir as defaultConfigDir } from '@ultracontext/sync';

// -- types --------------------------------------------------------------------

// deps every read takes — configDir defaults to ~/.ultracontext for the real CLI
export type ManifestDeps = { configDir?: string };

// a parsed driver manifest. `dir` is the driver's directory (where its toml lives)
export type DriverManifest = {
    name: string;
    version?: string;
    type?: string;
    runtime?: string;
    capabilities?: Record<string, boolean>;
    commands: Record<string, string>;
    dir: string;
};

// a list entry: a parsed manifest, OR a per-driver error (name + clear message)
// so one broken driver never crashes the whole listing.
export type DriverListing = DriverManifest & { error?: string };

// -- paths --------------------------------------------------------------------

// resolve <configDir>/drivers (the install root for all driver dirs)
export function driversDir(configDir?: string): string {
    return join(configDir ?? defaultConfigDir(), 'drivers');
}

// -- name validation ----------------------------------------------------------

// a driver name is lowercase kebab-case (matches the spec + the dir-name rule)
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// reject a non-kebab name with a clear message (used before any fs touch)
function validateName(name: string): void {
    if (!KEBAB.test(name)) {
        throw new Error(`invalid driver name: ${name}. Use lowercase kebab-case (letters, numbers, hyphens).`);
    }
}

// -- parse --------------------------------------------------------------------

// read + parse one driver.toml into the typed manifest. The dir-name is passed
// so name/dir mismatch (per the spec) surfaces as a clear error. NEVER includes
// the manifest body in any error message — secrets must not reach a log.
async function parseManifest(dirName: string, dir: string): Promise<DriverManifest> {
    const raw = await readFile(join(dir, 'driver.toml'), 'utf8');

    // parse via smol-toml — a syntax error is reported against the driver, not echoed
    let doc: Record<string, unknown>;
    try {
        doc = parseToml(raw) as Record<string, unknown>;
    } catch {
        throw new Error(`driver ${dirName}: invalid driver.toml`);
    }

    // name is REQUIRED, kebab-case, and must equal the directory name
    const name = doc.name;
    if (typeof name !== 'string') throw new Error(`driver ${dirName}: manifest missing name`);
    validateName(name);
    if (name !== dirName) throw new Error(`driver ${dirName}: manifest name "${name}" does not match directory`);

    // commands is the required map of verb → shell string
    const commands = (doc.commands as Record<string, string>) ?? {};

    // capabilities is an optional booleans map
    const capabilities = doc.capabilities as Record<string, boolean> | undefined;

    return {
        name,
        version: typeof doc.version === 'string' ? doc.version : undefined,
        type: typeof doc.type === 'string' ? doc.type : undefined,
        runtime: typeof doc.runtime === 'string' ? doc.runtime : undefined,
        capabilities,
        commands,
        dir,
    };
}

// -- list ---------------------------------------------------------------------

// list every installed driver. A missing drivers/ dir is empty (not an error);
// a dir without driver.toml is skipped; a manifest that fails to parse or breaks
// the contract surfaces as a per-driver `error` entry, never a crash.
export async function listDrivers(deps: ManifestDeps = {}): Promise<DriverListing[]> {
    const root = driversDir(deps.configDir);

    // a missing root simply means no drivers installed yet
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (!entries) return [];

    // parse each subdir that holds a driver.toml; collect errors per-driver
    const out: DriverListing[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const dir = join(root, entry.name);
        const hasManifest = await stat(join(dir, 'driver.toml')).then((s) => s.isFile()).catch(() => false);
        if (!hasManifest) continue;

        try {
            out.push(await parseManifest(entry.name, dir));
        } catch (error) {
            out.push({ name: entry.name, commands: {}, dir, error: (error as Error).message });
        }
    }

    // stable, name-sorted surface
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// -- load ---------------------------------------------------------------------

// load one driver by name (validated kebab first). A missing driver dir or
// manifest → a clear not-found error naming the driver + the path it looked in.
export async function loadDriver(name: string, deps: ManifestDeps = {}): Promise<DriverManifest> {
    validateName(name);

    // the manifest must exist at <drivers>/<name>/driver.toml
    const dir = join(driversDir(deps.configDir), name);
    const hasManifest = await stat(join(dir, 'driver.toml')).then((s) => s.isFile()).catch(() => false);
    if (!hasManifest) throw new Error(`driver not found: ${name} (${join(dir, 'driver.toml')})`);

    return parseManifest(name, dir);
}
