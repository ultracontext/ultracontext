// =============================================================================
// devtools-hook (NODE) — the node half of the swappable `#devtools-hook` seam.
// There is no DOM here, so the hook is a NO-OP: the CLI, the node SDK build,
// and SSR all construct UltraContext without ever touching overlay code. The
// browser build aliases the seam to devtools-hook.browser.ts instead.
// =============================================================================

import type { UltraContextConfig } from './ultracontext';

// same signature as the browser hook — deliberately does nothing on node
export function maybeAttachDevtools(_uc: unknown, _mode: 'local' | 'remote', _cfg: UltraContextConfig): void {}
