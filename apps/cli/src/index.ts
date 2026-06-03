// =============================================================================
// ultracontext — public entry. Re-exports the @ultracontext/js types + helpers,
// then SHADOWS its UltraContext with the UNIFIED facade so `import 'ultracontext'`
// gives the local-by-default, remote-opt-in client. The explicit named export
// below wins over the star's UltraContext. The `uc` binary lives in src/cli/.
// =============================================================================

export * from '@ultracontext/js';

// the unified facade replaces the remote-only UltraContext (explicit > star)
export { UltraContext } from '../lib/sdk/ultracontext';
export type { UltraContextConfig } from '../lib/sdk/ultracontext';
