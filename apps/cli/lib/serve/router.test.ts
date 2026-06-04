// =============================================================================
// router.test — the tiny method+path router (no framework, works under node:http
// and bun --compile). Covers: a static route matches its method+path; a
// parameterized :id route binds the segment; a static route is preferred over a
// param route at the same depth (delete-many before :id); query strings are
// stripped before matching; an unknown route returns null.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { matchRoute } from './router';

// the table the server registers — order encodes priority (static before param)
const routes = [
    { method: 'POST', path: '/contexts', name: 'create' },
    { method: 'GET', path: '/contexts', name: 'list' },
    { method: 'POST', path: '/contexts/delete-many', name: 'delete-many' },
    { method: 'POST', path: '/contexts/:id', name: 'append' },
    { method: 'GET', path: '/contexts/:id', name: 'get' },
    { method: 'POST', path: '/events', name: 'commit-event' },
] as const;

// -- matching ------------------------------------------------------------------

describe('matchRoute', () => {
    // a static route matches its method + exact path
    it('matches a static route', () => {
        const m = matchRoute(routes, 'POST', '/contexts');
        assert.equal(m?.route.name, 'create');
        assert.deepEqual(m?.params, {});
    });

    // a :id route binds the dynamic segment into params
    it('binds a param segment', () => {
        const m = matchRoute(routes, 'GET', '/contexts/ctx_abc');
        assert.equal(m?.route.name, 'get');
        assert.equal(m?.params.id, 'ctx_abc');
    });

    // a static route at the same depth wins over the param route (registration order)
    it('prefers a static route over a param route', () => {
        const m = matchRoute(routes, 'POST', '/contexts/delete-many');
        assert.equal(m?.route.name, 'delete-many');
    });

    // the query string is ignored when matching the path
    it('strips the query string before matching', () => {
        const m = matchRoute(routes, 'GET', '/contexts/ctx_abc?version=1');
        assert.equal(m?.route.name, 'get');
        assert.equal(m?.params.id, 'ctx_abc');
    });

    // an unknown method/path returns null (the server answers 404)
    it('returns null for an unknown route', () => {
        assert.equal(matchRoute(routes, 'DELETE', '/nope'), null);
    });
});
