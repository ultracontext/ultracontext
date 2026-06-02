// =============================================================================
// version — the CLI version, sourced once from the package's own package.json
// so doctor/upgrade/main never drift from the published version. The reader is
// injectable for tests; the default resolves the file relative to this module.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// -- compile-time version -----------------------------------------------------

// the `bun --compile` build injects this via --define UC_COMPILED_VERSION="x.y.z"
// (see scripts/build-binaries.sh). The standalone binary can't readFileSync the
// package.json (it isn't embedded), so the define is its source of truth.
// Under Node the define is absent and we fall through to the package.json reader.
declare const UC_COMPILED_VERSION: string | undefined;

// -- reader -------------------------------------------------------------------

// read the package.json text next to the built/source module (../package.json)
function defaultReader(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', 'package.json'), 'utf8');
}

// -- resolver -----------------------------------------------------------------

// the compiled-binary version when present (define is replaced inline by the
// bundler); '' under Node so resolveVersion falls back to the package.json read.
function compiledVersion(): string {
    return typeof UC_COMPILED_VERSION !== 'undefined' ? UC_COMPILED_VERSION : '';
}

// prefer the compile-time define; otherwise parse package.json; else 0.0.0
export function resolveVersion(read: () => string = defaultReader): string {
    const injected = compiledVersion();
    if (injected) return injected;

    try {
        const pkg = JSON.parse(read()) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

// the resolved version — computed once at import time
export const VERSION = resolveVersion();
