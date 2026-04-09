import type { KeyCache } from '../cache/types';
import { KEY_PREFIX_LEN } from '../constants';
import { hashKey } from '../domain/api-keys';
import type { HttpApp, HttpContext, HttpMiddleware } from '../types/http';

// -- helpers ------------------------------------------------------------------

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

async function recordApiKeyUse(c: HttpContext, apiKeyId: number) {
    try {
        await c.get('storage').updateApiKeyLastUsedAt(apiKeyId, new Date().toISOString());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to update api_keys.last_used_at for key ${apiKeyId}: ${message}`);
    }
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

// -- token verification -------------------------------------------------------

function createTokenVerifier(keyCache?: KeyCache) {
    return async function verifyToken(token: string, c: HttpContext) {
        const prefix = token.slice(0, KEY_PREFIX_LEN);
        const hash = await hashKey(token);

        // check cache first
        if (keyCache) {
            const cached = await keyCache.get(prefix);
            if (cached && cached.keyHash === hash) {
                c.set('auth', { apiKeyId: cached.apiKeyId, projectId: cached.projectId });
                await recordApiKeyUse(c, cached.apiKeyId);
                return true;
            }
        }

        // fallback to storage
        const storage = c.get('storage');
        const tokenRow = await storage.findApiKeyByPrefix(prefix);
        if (!tokenRow || hash !== tokenRow.key_hash) return false;

        c.set('auth', { apiKeyId: tokenRow.id, projectId: tokenRow.project_id });

        // populate cache on success
        if (keyCache) {
            await keyCache.put(prefix, {
                keyHash: hash,
                apiKeyId: tokenRow.id,
                projectId: tokenRow.project_id,
            });
        }

        await recordApiKeyUse(c, tokenRow.id);

        return true;
    };
}

async function verifyAdminToken(token: string, c: HttpContext) {
    const expected = c.get('config').ULTRACONTEXT_ADMIN_KEY;
    if (!expected) return false;
    return token === expected;
}

// -- registration -------------------------------------------------------------

export type AuthOptions = {
    keyCache?: KeyCache;
};

export function registerAuthMiddleware(app: HttpApp, options?: AuthOptions) {
    const verifyToken = createTokenVerifier(options?.keyCache);

    app.use('/contexts/*', bearerAuthMiddleware(verifyToken));
    app.use('/mcp', bearerAuthMiddleware(verifyToken));
    app.use('/v1/keys', bearerAuthMiddleware(verifyAdminToken));
}
