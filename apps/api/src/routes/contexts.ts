import {
    appendMessages,
    createContext,
    deleteContextPermanent,
    deleteManyContexts,
    deleteMessages,
    getContext,
    isPlainObject,
    listContexts,
    resultStatus,
    updateMessages,
    type ContextFilters,
    type ErrorCode,
} from '@ultracontext/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpApp } from '../types/http';

// -- error status (core code -> Hono-typed HTTP status) -----------------------

const status = (code: ErrorCode) => resultStatus(code) as ContentfulStatusCode;

// -- routes -------------------------------------------------------------------

export function registerContextRoutes(app: HttpApp) {
    // create context — parse body (default {} on bad JSON), call core, map Result
    app.post('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => ({}));

        const result = await createContext(storage, projectId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data, 201);
    });

    // list contexts — parse query params + filters, call core listContexts
    app.get('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const limit = parseInt(c.req.query('limit') ?? '20');

        // metadata + timestamp filters
        const filters: ContextFilters & { limit?: number } = { limit };
        const source = c.req.query('source');
        const userId = c.req.query('user_id');
        const host = c.req.query('host');
        const projectPath = c.req.query('project_path');
        const sessionId = c.req.query('session_id');
        const after = c.req.query('after');
        const before = c.req.query('before');
        if (source) filters.source = source;
        if (userId) filters.user_id = userId;
        if (host) filters.host = host;
        if (projectPath) filters.project_path = projectPath;
        if (sessionId) filters.session_id = sessionId;
        if (after) {
            if (isNaN(Date.parse(after))) return c.json({ error: 'Invalid after timestamp' }, 400);
            filters.after = after;
        }
        if (before) {
            if (isNaN(Date.parse(before))) return c.json({ error: 'Invalid before timestamp' }, 400);
            filters.before = before;
        }

        const data = await listContexts(storage, projectId, filters);
        return c.json(data);
    });

    // -- delete-many contexts (must be registered before :id routes) -----------

    // delete-many — parse body (must be JSON object), call core, compute status
    app.post('/contexts/delete-many', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => null);

        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);

        const { ids } = body;
        const result = await deleteManyContexts(storage, projectId, ids as string[]);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));

        // 207 Multi-Status when partial failure; 500 if every item failed
        const { deleted_count } = result.data;
        const total = result.data.results.length;
        const httpStatus = deleted_count === 0 ? 500 : deleted_count === total ? 200 : 207;
        return c.json(result.data, httpStatus);
    });

    // -- parameterized :id routes ------------------------------------------------

    // append messages — parse JSON body (no catch, matches prior behavior)
    app.post('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json();

        const result = await appendMessages(storage, projectId, contextPublicId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data, 201);
    });

    // get context — parse query selectors, call core, map Result
    app.get('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        const opts = {
            version: c.req.query('version'),
            at: c.req.query('at'),
            before: c.req.query('before'),
            history: c.req.query('history') === 'true',
        };

        const result = await getContext(storage, projectId, contextPublicId, opts);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data);
    });

    // update messages — parse JSON body (null on bad JSON -> 400), call core
    app.patch('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json().catch(() => null);

        if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);

        const result = await updateMessages(storage, projectId, contextPublicId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data);
    });

    // -- delete context or messages -----------------------------------------------

    // delete — disambiguate permanent-delete vs message-delete from the body shape
    app.delete('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        // Check Content-Type to distinguish "no body" from "JSON body"
        const contentType = c.req.header('content-type') ?? '';
        const hasJsonBody = contentType.includes('application/json');

        let body: any = null;
        if (hasJsonBody) {
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400);
            }
        }

        // Permanent delete path: no body, OR explicit {permanent: true}. Any other body shape must opt
        // in explicitly to prevent typos (e.g. `{IDs:[...]}`, `{id:"x"}`) from silently wiping the context.
        const isEmptyBody = isPlainObject(body) && Object.keys(body).length === 0;
        const isExplicitPermanent = isPlainObject(body) && body.permanent === true;
        const hasIds = isPlainObject(body) && body.ids !== undefined;

        // Reject ambiguous bodies that combine both — forces the caller to pick one
        if (isExplicitPermanent && hasIds) {
            return c.json({ error: 'Cannot combine "permanent" and "ids" in the same request — pick one' }, 400);
        }

        // permanent delete — no body / {} / {permanent: true}; echo optional audit metadata
        if (!hasJsonBody || isEmptyBody || isExplicitPermanent) {
            // Optional audit metadata logged at infra level (permanent delete wipes history)
            const auditMetadata = isPlainObject(body) && isPlainObject(body.metadata) ? body.metadata : undefined;
            if (auditMetadata) {
                console.info(JSON.stringify({ op: 'permanent_delete', project_id: projectId, context_id: contextPublicId, metadata: auditMetadata }));
            }

            const result = await deleteContextPermanent(storage, projectId, contextPublicId, { auditMetadata });
            if (!result.ok) return c.json({ error: result.message }, status(result.code));
            return c.json(result.data);
        }

        // From here, body must have `ids` for message-delete path
        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);
        if (!hasIds) {
            return c.json({ error: 'Body must contain "ids" (delete messages) or {"permanent": true} (delete entire context)' }, 400);
        }

        // message delete — pass ids + optional metadata to core (core validates shapes)
        const { ids, metadata: userMetadata } = body;
        const result = await deleteMessages(storage, projectId, contextPublicId, {
            ids: ids as (string | number)[],
            userMetadata: userMetadata as Record<string, unknown> | undefined,
        });
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data);
    });
}
