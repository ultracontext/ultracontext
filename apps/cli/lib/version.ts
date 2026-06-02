// =============================================================================
// version — the CLI version, sourced once from the package's own package.json
// so doctor/upgrade/main never drift from the published version. The reader is
// injectable for tests; the default resolves the file relative to this module.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// -- reader -------------------------------------------------------------------

// read the package.json text next to the built/source module (../package.json)
function defaultReader(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', 'package.json'), 'utf8');
}

// -- resolver -----------------------------------------------------------------

// parse the version out of package.json; degrade to 0.0.0 when unreadable
export function resolveVersion(read: () => string = defaultReader): string {
    try {
        const pkg = JSON.parse(read()) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

// the resolved version — computed once at import time
export const VERSION = resolveVersion();
