import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// inline the private @ultracontext/* workspace libs — they are never published,
// so they must be bundled into dist. Real npm deps stay external (resolved on install).
const inlineWorkspace = [/^@ultracontext\//];

// keep the libsql + drizzle subtree EXTERNAL — libsql loads a platform-native
// addon via runtime require('@libsql/<platform>') that an inlined bundle cannot
// resolve from apps/cli. Declared as runtime deps so `npm i` installs them next
// to the bin (npm pulls libsql's optional native packages for the host platform).
const externalRuntime = [/^@libsql\//, 'libsql', /^drizzle-orm/];

// keep sql.js EXTERNAL in the browser build — it is a real npm dep the consuming
// web app installs; bundling its wasm into our dist would be wrong (apps own the
// wasm asset + locateFile). It loads lazily, so remote-only apps never touch it.
const externalBrowser = ['sql.js', /^drizzle-orm/];

// resolve the `#local-backend` seam per build: the node + bin builds get the node
// loader (libsql/bun sqlite); the browser build is ALIASED to the sql.js loader.
// tsdown's "imports" resolution would also pick `default`, so we alias explicitly
// in the browser build to GUARANTEE the swap lands in the emitted bundle.
const nodeBackend = fileURLToPath(new URL('./lib/sdk/local-backend.ts', import.meta.url));
const browserBackend = fileURLToPath(new URL('./lib/sdk/local-backend.browser.ts', import.meta.url));

export default defineConfig([
    // uc binary — CLI entry with workspace libs inlined + a node shebang
    {
        entry: ['src/cli/bin.ts'],
        outDir: 'dist',
        format: 'esm',
        platform: 'node',
        clean: true,
        noExternal: inlineWorkspace,
        external: externalRuntime,
        // resolve the local-backend seam to the node loader
        alias: { '#local-backend': nodeBackend },
        // emit dist/uc.mjs (the bin target) instead of dist/bin.mjs
        outputOptions: { entryFileNames: 'uc.mjs' },
    },
    // SDK re-export (NODE) — `import 'ultracontext'` (node/bun) resolves here
    {
        entry: ['src/index.ts'],
        outDir: 'dist',
        format: 'esm',
        platform: 'node',
        // eager DTS so inlined SDK types are emitted (not dropped to `export {}`)
        dts: { eager: true },
        noExternal: inlineWorkspace,
        external: externalRuntime,
        // resolve the local-backend seam to the node loader
        alias: { '#local-backend': nodeBackend },
    },
    // SDK re-export (BROWSER) — `import 'ultracontext'` (default condition) resolves
    // here. Workspace libs inlined; sql.js external; the seam aliased to the sql.js
    // + IndexedDB loader so NO libsql/node code lands in the output graph.
    {
        entry: ['src/index.browser.ts'],
        outDir: 'dist',
        format: 'esm',
        platform: 'browser',
        // NO dts here — the exports map's `types` points at dist/index.d.mts (the
        // single unified surface); a browser dts pass emits a malformed orphan.
        dts: false,
        noExternal: inlineWorkspace,
        external: externalBrowser,
        // resolve the local-backend seam to the BROWSER (sql.js + IndexedDB) loader
        alias: { '#local-backend': browserBackend },
        // emit dist/index.browser.mjs (match the exports map target)
        outputOptions: { entryFileNames: 'index.browser.mjs' },
    },
]);
