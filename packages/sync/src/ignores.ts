// =============================================================================
// ignores — the sync ignore subsystem. A GLOBAL ignore file under
// <configDir>/ignores/.ultracontextignore, seeded with the defaults on first
// use, plus per-source <configDir>/ignores/<source>/.ultracontextignore files.
// Non-blank, non-`#` lines from BOTH become repeated `--ignore=` mutagen args.
// =============================================================================

import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';

// -- injectable deps ----------------------------------------------------------

// the seam the subsystem touches — `configDir` is the ~/.ultracontext root
export type IgnoreDeps = {
    configDir: string;
};

// -- constants ----------------------------------------------------------------

// the ignore file leaf name (shared by the global + per-source files)
const IGNORE_FILE = '.ultracontextignore';

// the ignores subdirectory inside the config dir
const IGNORES_DIR = 'ignores';

// the default global ignore file body — ported verbatim from the 2.0 CLI
const DEFAULT_IGNORE_FILE = `# UltraContext ignore file
# Global patterns use Mutagen's default ignore syntax and apply to every synced source.
# Source-specific rules live in ~/.ultracontext/ignores/<source>/.ultracontextignore.
# Comment, edit, or extend any rule. Run \`uc sync reset\` after ignore edits.

# Source control
.git/

# Build and dependency dirs
node_modules/
target/
dist/
build/
.next/
.cache/

# Runtime logs
logs/
*.log
*.log.*

# Browser/electron caches (gstack, openclaw, codex web UI)
Cache/
Cache_Data/
GPUCache/
Code Cache/
blob_storage/

# Sqlite write-ahead and shared-memory sidecars (the .sqlite itself still syncs)
*.sqlite-wal
*.sqlite-shm

# OS noise
.DS_Store

# Add extra ignore patterns below.
`;

// -- paths --------------------------------------------------------------------

// the ignores subdirectory for a given config dir
function ignoresDir(configDir: string): string {
    return join(configDir, IGNORES_DIR);
}

// the global ignore file path: <configDir>/ignores/.ultracontextignore
export function ignorePath(configDir: string): string {
    return join(ignoresDir(configDir), IGNORE_FILE);
}

// a per-source ignore file path: <configDir>/ignores/<source>/.ultracontextignore
export function sourceIgnorePath(configDir: string, sourceName: string): string {
    return join(ignoresDir(configDir), sourceName, IGNORE_FILE);
}

// -- seeding ------------------------------------------------------------------

// seed the global ignore file with the defaults when it is absent (no clobber)
export async function ensureIgnoreFiles(deps: IgnoreDeps): Promise<void> {
    const path = ignorePath(deps.configDir);
    if (await fileExists(path)) return;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, DEFAULT_IGNORE_FILE, 'utf8');
}

// -- pattern collection -------------------------------------------------------

// merge global + per-source ignore patterns into one ordered, deduped-by-file list
export async function collectIgnorePatterns(deps: IgnoreDeps, sourceName: string): Promise<string[]> {
    const global = await readPatterns(ignorePath(deps.configDir));
    const perSource = await readPatterns(sourceIgnorePath(deps.configDir, sourceName));
    return [...global, ...perSource];
}

// read an ignore file into its meaningful patterns (skip blanks + `#` comments)
async function readPatterns(path: string): Promise<string[]> {
    if (!(await fileExists(path))) return [];

    const raw = await readFile(path, 'utf8');
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// -- small fs helper ----------------------------------------------------------

// whether a path exists on disk (no throw)
async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
