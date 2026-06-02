import { defineConfig } from 'tsdown';

// inline the private @ultracontext/* workspace libs — they are never published,
// so they must be bundled into dist. Real npm deps stay external (resolved on install).
const inlineWorkspace = [/^@ultracontext\//];

// keep the libsql + drizzle subtree EXTERNAL — libsql loads a platform-native
// addon via runtime require('@libsql/<platform>') that an inlined bundle cannot
// resolve from apps/cli. Declared as runtime deps so `npm i` installs them next
// to the bin (npm pulls libsql's optional native packages for the host platform).
const externalRuntime = [/^@libsql\//, 'libsql', /^drizzle-orm/];

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
        // emit dist/uc.mjs (the bin target) instead of dist/bin.mjs
        outputOptions: { entryFileNames: 'uc.mjs' },
    },
    // SDK re-export — `import 'ultracontext'` resolves to the bundled SDK
    {
        entry: ['src/index.ts'],
        outDir: 'dist',
        format: 'esm',
        platform: 'node',
        // eager DTS so inlined SDK types are emitted (not dropped to `export {}`)
        dts: { eager: true },
        noExternal: inlineWorkspace,
        external: externalRuntime,
    },
]);
