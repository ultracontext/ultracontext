import { createKey, resultStatus, type ErrorCode } from '@ultracontext/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpApp } from '../types/http';

// -- error status (core code -> Hono-typed HTTP status) -----------------------

const status = (code: ErrorCode) => resultStatus(code) as ContentfulStatusCode;

export function registerKeyRoutes(app: HttpApp) {
    // create key — parse body (default {} on bad JSON), call core, map Result
    app.post('/v1/keys', async (c) => {
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => ({}));
        const { name } = body;

        const result = await createKey(storage, name);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data);
    });
}
