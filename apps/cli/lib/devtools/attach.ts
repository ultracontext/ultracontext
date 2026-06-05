// =============================================================================
// attach — mounts the overlay ONCE per page. The dev/prod/document gate already
// ran in the entry-chunk hook (devtools-hook.browser.ts) before this module was
// even fetched; here we only dedupe (a global marker covers React StrictMode
// double-construct AND duplicate SDK copies) and lazy-load the DOM layer.
// =============================================================================

import type { UltraContext } from '../sdk/ultracontext';
import type { DevtoolsFlag, DevtoolsInfo } from './gate';

// -- types --------------------------------------------------------------------

export type DevtoolsHandle = { destroy(): void };

// global so two bundled copies of the SDK still share one overlay
const MARKER = '__ultracontextDevtools__';

// -- attach -------------------------------------------------------------------

// mount the overlay for this client; null when one is already on the page
export async function attachDevtools(uc: UltraContext, info: DevtoolsInfo, flag: DevtoolsFlag): Promise<DevtoolsHandle | null> {
    // one overlay per page — the first client wins, later ones no-op
    const g = globalThis as Record<string, unknown>;
    if (g[MARKER]) return null;
    g[MARKER] = true;

    // the DOM layer stays behind its own dynamic import (one more lazy chunk)
    const { mountDevtools } = await import('./ui');
    const position = typeof flag === 'object' ? flag.position ?? 'top-right' : 'top-right';
    const ui = mountDevtools(uc, info, position);

    return {
        destroy() {
            ui.destroy();
            delete g[MARKER];
        },
    };
}
