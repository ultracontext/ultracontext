// =============================================================================
// ultracontext (BROWSER entry) — identical public surface to src/index.ts. The
// ONLY difference is the build: tsdown aliases the `#local-backend` seam inside
// the UltraContext facade to the BROWSER loader (sql.js + IndexedDB) and targets
// platform 'browser', so `import 'ultracontext'` in a web app gets local-first
// in the browser. @ultracontext/js is fetch-only (browser-pure); the facade is
// ONE class shared with node. The `uc` binary is node-only and not exported here.
// =============================================================================

export * from '@ultracontext/js';

// the unified facade replaces the remote-only UltraContext (explicit > star)
export { UltraContext } from '../lib/sdk/ultracontext';
export type { UltraContextConfig, DevtoolsOptions, DevtoolsPosition } from '../lib/sdk/ultracontext';
