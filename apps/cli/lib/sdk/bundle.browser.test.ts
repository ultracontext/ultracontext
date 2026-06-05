// =============================================================================
// bundle.browser.test — the ACCEPTANCE that the package's BROWSER entry actually
// bundles for the web. Runs esbuild programmatically over a fixture importing the
// browser entry (platform browser, browser conditions, esm, sql.js EXTERNAL — the
// app installs it). The build MUST succeed, then we SCAN every emitted chunk:
//   • zero "node:" specifiers          (no node builtins leak in)
//   • zero process.cwd                 (no node-only globals)
//   • zero @libsql / libsql / drizzle-orm/libsql refs (no node sqlite driver)
//   • sql.js + sqlite-browser sit behind a DYNAMIC import (a lazy chunk, NOT the
//     entry chunk) so remote-only apps never download the wasm engine
// This drives the SAME resolution a real Vite/esbuild web app would: the
// `#local-backend` seam resolves to the browser loader under the browser condition.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// -- fixture entry -------------------------------------------------------------

// the browser entry the published package exposes under the `default` condition
const BROWSER_ENTRY = fileURLToPath(new URL('../../src/index.browser.ts', import.meta.url));

// -- bundle helper -------------------------------------------------------------

// bundle the browser entry exactly as a web app would, returning all output text
// keyed by file name (in-memory; write:false) plus the esbuild metafile.
// `define` lets a test pin replacements (e.g. keep NODE_ENV literal).
async function bundleBrowser(define?: Record<string, string>): Promise<{ files: Record<string, string>; metafile: import('esbuild').Metafile }> {
    const result = await build({
        entryPoints: [BROWSER_ENTRY],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        // the conditions a browser bundler applies — picks the browser seam + libs
        conditions: ['browser', 'import', 'default'],
        // sql.js is a real npm dep the consuming app installs — not our wasm to ship
        external: ['sql.js'],
        // emit chunks so a dynamic import lands in its OWN file (lazy chunk)
        splitting: true,
        outdir: 'out',
        write: false,
        metafile: true,
        logLevel: 'silent',
        define,
    });

    // map every emitted chunk to its text for scanning
    const files: Record<string, string> = {};
    for (const file of result.outputFiles) files[file.path] = file.text;
    return { files, metafile: result.metafile };
}

// strip // line and /* block */ comments so doc-comment mentions of node-only
// tokens never false-fail the specifier scan (only real code references matter)
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// -- the smoke -----------------------------------------------------------------

describe('browser bundle — works in a web app', () => {
    // the build itself must succeed with sql.js external (no resolution errors)
    it('bundles the browser entry without errors', async () => {
        const { files } = await bundleBrowser();
        assert.ok(Object.keys(files).length > 0, 'esbuild emitted at least one chunk');
    });

    // no node builtins, no node-only globals, no node sqlite driver anywhere.
    // We scan IMPORT/REQUIRE SPECIFIERS (the load-bearing references) — strip
    // comments first so a harmless mention in a doc comment never false-fails.
    it('emits zero node: / process.cwd / libsql / drizzle-libsql references', async () => {
        const { files } = await bundleBrowser();
        const all = stripComments(Object.values(files).join('\n'));

        // node builtin specifiers (node:path, node:fs, …) must not survive
        assert.doesNotMatch(all, /["']node:/, 'a node: specifier leaked into the browser bundle');

        // no node-only globals
        assert.doesNotMatch(all, /process\.cwd/, 'process.cwd leaked into the browser bundle');

        // the node sqlite driver subtree must be entirely absent
        assert.doesNotMatch(all, /@libsql\//, '@libsql/* leaked into the browser bundle');
        assert.doesNotMatch(all, /["']libsql["']/, 'libsql leaked into the browser bundle');
        assert.doesNotMatch(all, /drizzle-orm\/libsql/, 'drizzle-orm/libsql leaked into the browser bundle');
        assert.doesNotMatch(all, /drizzle-orm\/bun-sqlite/, 'drizzle-orm/bun-sqlite leaked into the browser bundle');
        assert.doesNotMatch(all, /["']bun:sqlite["']/, 'bun:sqlite leaked into the browser bundle');
    });

    // sql.js + the sqlite-browser code must be LAZY — behind a dynamic import,
    // so a remote-only app's entry chunk never references the wasm engine.
    it('keeps sql.js / sqlite-browser behind a dynamic import (lazy chunk)', async () => {
        const { files, metafile } = await bundleBrowser();

        // locate the ENTRY chunk via the metafile (the one marked entryPoint)
        const entryPath = Object.keys(metafile.outputs).find((p) => metafile.outputs[p].entryPoint);
        assert.ok(entryPath, 'an entry chunk exists in the metafile');

        // resolve the entry chunk's text (esbuild metafile paths are outdir-relative)
        const entryText = files[Object.keys(files).find((p) => p.endsWith(entryPath!.replace(/^out\//, '')))!];
        assert.ok(entryText, 'entry chunk text resolved');

        // the entry must NOT statically import sql.js — it is reached lazily only
        assert.doesNotMatch(entryText, /\bfrom\s*["']sql\.js["']/, 'entry statically imports sql.js (should be lazy)');
        assert.doesNotMatch(entryText, /\bimport\s+["']sql\.js["']/, 'entry statically imports sql.js (should be lazy)');

        // sql.js must appear SOMEWHERE (the lazy chunk references it externally),
        // and the entry must contain a dynamic import that pulls a separate chunk.
        const all = Object.values(files).join('\n');
        assert.match(all, /sql\.js/, 'sql.js is referenced (lazily) by some chunk');
        assert.match(entryText, /import\(/, 'entry uses a dynamic import for the lazy local backend');
    });

    // the dev overlay: its GATE lives in the entry chunk (so prod never fetches
    // the UI) and the DOM layer lives in a LAZY chunk.
    it('keeps the devtools UI out of the entry chunk (lazy)', async () => {
        const { files, metafile } = await bundleBrowser();

        // resolve the entry chunk text (same lookup as the lazy-chunk test)
        const entryPath = Object.keys(metafile.outputs).find((p) => metafile.outputs[p].entryPoint);
        const entryText = files[Object.keys(files).find((p) => p.endsWith(entryPath!.replace(/^out\//, '')))!];
        assert.ok(entryText, 'entry chunk text resolved');

        // the DOM layer must NOT be in the entry chunk — it is lazy-loaded
        assert.doesNotMatch(entryText, /data-ultracontext-devtools/, 'devtools UI leaked into the entry chunk');
        assert.doesNotMatch(entryText, /attachShadow/, 'devtools shadow-DOM code leaked into the entry chunk');

        // but it must exist SOMEWHERE (a lazy chunk) for dev browsers to fetch
        const all = Object.values(files).join('\n');
        assert.match(all, /data-ultracontext-devtools/, 'devtools UI is emitted as a lazy chunk');
    });

    // the gate's NODE_ENV check must reach the consumer's bundler as a LITERAL
    // `process.env.NODE_ENV` (Next/Vite/webpack substitute it; prod kills the
    // overlay statically). The identity define mimics a bundler that does NOT
    // substitute — the literal must then survive into the entry chunk.
    it('ships a literal process.env.NODE_ENV in the entry chunk', async () => {
        const { files, metafile } = await bundleBrowser({ 'process.env.NODE_ENV': 'process.env.NODE_ENV' });

        const entryPath = Object.keys(metafile.outputs).find((p) => metafile.outputs[p].entryPoint);
        const entryText = files[Object.keys(files).find((p) => p.endsWith(entryPath!.replace(/^out\//, '')))!];
        assert.ok(entryText, 'entry chunk text resolved');

        assert.match(entryText, /process\.env\.NODE_ENV/, 'NODE_ENV literal survives for bundler substitution');
    });
});
