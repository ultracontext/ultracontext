import type { HttpMiddleware } from '../types/http';

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

export const corsMiddleware: HttpMiddleware = async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
    c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    c.header('Access-Control-Max-Age', '86400');
    c.header('Vary', 'Origin');

    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
};
