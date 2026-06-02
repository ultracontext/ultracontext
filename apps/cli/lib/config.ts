// =============================================================================
// config — ~/.ultracontext/ paths + atomic writes (write temp + rename).
// NOT XDG. SQLite self-locks via WAL, so no file-lock library here.
// =============================================================================

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

// -- paths --------------------------------------------------------------------

// root config dir: ~/.ultracontext
export const configDir = (): string => join(homedir(), '.ultracontext');

// config file: ~/.ultracontext/config.json
export const configPath = (): string => join(configDir(), 'config.json');

// local sqlite db: ~/.ultracontext/uc.db (libsql url form)
export const dbUrl = (): string => 'file:' + join(configDir(), 'uc.db');

// -- atomic write -------------------------------------------------------------

// write JSON atomically — temp file in the target's dir, then rename over it
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });

    // unique temp sibling so concurrent writers don't collide
    const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
}

// -- read ---------------------------------------------------------------------

// read + parse JSON; null when the file is absent (callers default sensibly)
export async function readJson<T = unknown>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
