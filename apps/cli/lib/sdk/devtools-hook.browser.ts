// =============================================================================
// devtools-hook (BROWSER) — the browser half of the swappable `#devtools-hook`
// seam, called from the UltraContext constructor. The GATE RUNS HERE, in the
// entry chunk: production (or `devtools: false`, or no document) returns before
// the dynamic import, so prod apps never even FETCH the overlay chunk. Dev
// browsers fall through and lazily mount the bubble. Fire-and-forget — the
// overlay can never break or delay the SDK.
// =============================================================================

import { shouldAttach, isProd } from '../devtools/gate';
import type { UltraContext, UltraContextConfig } from './ultracontext';

// decide in the entry chunk; mount from the lazy chunk
export function maybeAttachDevtools(uc: UltraContext, mode: 'local' | 'remote', cfg: UltraContextConfig): void {
    const hasDocument = typeof document !== 'undefined';
    if (!shouldAttach({ flag: cfg.devtools, prod: isProd(), hasDocument })) return;

    // lazy + silent: overlay failures must never surface into the app
    import('../devtools/attach')
        .then(({ attachDevtools }) => attachDevtools(uc, { mode, db: cfg.db ?? 'ultracontext.db' }, cfg.devtools))
        .catch(() => {});
}
