import { eq } from 'drizzle-orm';

import { KEY_PREFIX_LEN } from '../constants';
import { api_keys } from '../db';
import { hashKey } from '../domain/api-keys';
import type { HttpApp, HttpContext, HttpMiddleware } from '../types/http';

function readBearerToken(c: HttpContext): string | null {
    const authorization = c.req.header('authorization');
    if (!authorization) return null;

    const [scheme, token] = authorization.split(' ');
    if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
    return token;
}

function unauthorized(c: HttpContext) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
}

function bearerAuthMiddleware(verify: (token: string, c: HttpContext) => Promise<boolean>): HttpMiddleware {
    return async (c, next) => {
        const token = readBearerToken(c as HttpContext);
        if (!token) return unauthorized(c as HttpContext);

        const ok = await verify(token, c as HttpContext);
        if (!ok) return unauthorized(c as HttpContext);

        await next();
    };
}

async function verifyToken(token: string, c: HttpContext) {
    const prefix = token.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(token);
    const db = c.get('db');

    const tokenRows = await db
        .select({
            id: api_keys.id,
            project_id: api_keys.project_id,
            key_hash: api_keys.key_hash,
        })
        .from(api_keys)
        .where(eq(api_keys.key_prefix, prefix))
        .limit(1);

    const tokenRow = tokenRows[0] as { id: number; project_id: number; key_hash: string } | undefined;
    if (!tokenRow || hash !== tokenRow.key_hash) return false;

    c.set('auth', { apiKeyId: tokenRow.id, projectId: tokenRow.project_id });
    return true;
}

async function verifyAdminToken(token: string, c: HttpContext) {
    const expected = c.get('config').ULTRACONTEXT_ADMIN_KEY;
    if (!expected) return false;
    return token === expected;
}

export function registerAuthMiddleware(app: HttpApp) {
    app.use('/contexts/*', bearerAuthMiddleware(verifyToken));
    app.use('/v1/keys', bearerAuthMiddleware(verifyAdminToken));
}
