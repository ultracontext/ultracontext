// =============================================================================
// router — a tiny method+path matcher. NO framework (so the same code runs under
// node:http AND the bun --compile standalone binary). A route is a literal path
// with `:name` segments; the first route (in registration order) whose method +
// segment count + literals all match wins — so a static route registered before
// a param route at the same depth takes priority. Query strings are stripped.
// =============================================================================

// -- route shape ---------------------------------------------------------------

// one registered route — method, the `/a/:id` pattern, and an opaque payload the
// server reads (a handler name / fn). Generic over the payload so the server
// keeps its handler type without the router knowing it.
export type Route<T> = { method: string; path: string } & T;

// the resolved match: the winning route + the bound `:name` → value params
export type RouteMatch<T> = { route: Route<T>; params: Record<string, string> };

// -- split ---------------------------------------------------------------------

// split a path into non-empty segments ('/a/b' → ['a','b']); a leading/trailing
// slash never yields an empty segment, so the segment count is comparable.
function segments(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0);
}

// -- match ---------------------------------------------------------------------

// match one route's pattern against the request segments, binding `:name` params.
// returns null when the literal/segment-count check fails.
function matchOne<T>(route: Route<T>, reqSegments: string[]): Record<string, string> | null {
    const pattern = segments(route.path);
    if (pattern.length !== reqSegments.length) return null;

    // walk both segment lists: a `:name` binds, a literal must match exactly
    const params: Record<string, string> = {};
    for (let i = 0; i < pattern.length; i++) {
        const p = pattern[i];
        if (p.startsWith(':')) {
            params[p.slice(1)] = decodeURIComponent(reqSegments[i]);
        } else if (p !== reqSegments[i]) {
            return null;
        }
    }
    return params;
}

// -- matchRoute ----------------------------------------------------------------

// find the first route (registration order) matching the method + path. The
// query string is stripped before matching. null when nothing matches (→ 404).
export function matchRoute<T>(routes: readonly Route<T>[], method: string, url: string): RouteMatch<T> | null {
    // strip the query string — only the path participates in matching
    const path = url.split('?')[0];
    const reqSegments = segments(path);

    // first method-matching route whose pattern matches wins (order = priority)
    for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchOne(route, reqSegments);
        if (params) return { route, params };
    }
    return null;
}
