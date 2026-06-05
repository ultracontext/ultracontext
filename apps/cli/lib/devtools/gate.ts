// =============================================================================
// gate — the PURE decision for the dev overlay + the shared devtools types.
// Default ON in a dev browser, OFF in prod; `devtools: false` always wins;
// explicit `true`/options override prod; a missing document (SSR/edge/node)
// always blocks. isProd() keeps `process.env.NODE_ENV` LITERAL so the
// consumer's bundler (Next/Vite/webpack) statically swaps it at build time.
// =============================================================================

// -- types --------------------------------------------------------------------

// the overlay's corner anchor (Next-style; top-right is the default)
export type DevtoolsPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

// the `devtools` config knob: boolean toggle or an options object (= enabled)
export type DevtoolsOptions = { position?: DevtoolsPosition };
export type DevtoolsFlag = boolean | DevtoolsOptions | undefined;

// what the overlay displays about the client it watches
export type DevtoolsInfo = { mode: 'local' | 'remote'; db: string };

// -- decision -----------------------------------------------------------------

// should the overlay attach? Pure over its three inputs so it is fully testable.
export function shouldAttach(opts: { flag: DevtoolsFlag; prod: boolean; hasDocument: boolean }): boolean {
    // no DOM, no overlay — there is nothing to render into
    if (!opts.hasDocument) return false;

    // explicit false always wins; explicit true/options beat the prod heuristic
    if (opts.flag === false) return false;
    if (opts.flag !== undefined) return true;

    // default: dev-only
    return !opts.prod;
}

// -- environment --------------------------------------------------------------

// production check that SURVIVES bundler substitution: the literal
// `process.env.NODE_ENV` is replaced at the consumer's build time; the
// try/catch covers raw browsers where `process` does not exist (→ dev).
export function isProd(): boolean {
    try {
        return process.env.NODE_ENV === 'production';
    } catch {
        return false;
    }
}
