import type { ApiConfig } from '../types/api';
import type { StorageAdapter } from '../storage/types';
import type { HttpMiddleware } from '../types/http';

// -- factory: injects storage + config into request context -------------------

export function databaseMiddleware(storage: StorageAdapter, config: ApiConfig): HttpMiddleware {
    return async (c, next) => {
        c.set('storage', storage);
        c.set('config', config);
        await next();
    };
}
