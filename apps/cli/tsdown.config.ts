import { defineConfig } from 'tsdown';

// inline the private @ultracontext/* workspace libs — they are never published,
// so they must be bundled into dist. Real npm deps stay external (resolved on install).
const inlineWorkspace = [/^@ultracontext\//];

export default defineConfig([
    // uc binary — CLI entry with workspace libs inlined + a node shebang
    {
        entry: ['src/cli/bin.ts'],
        outDir: 'dist',
        format: 'esm',
        platform: 'node',
        clean: true,
        noExternal: inlineWorkspace,
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
    },
]);
