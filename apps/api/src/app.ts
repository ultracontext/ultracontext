import { Hono } from 'hono';

import type { KeyCache } from './cache/types';
import { registerAuthMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { databaseMiddleware } from './middleware/database';
import { registerContextRoutes } from './routes/contexts';
import { registerKeyRoutes } from './routes/keys';
import { registerMcpRoutes } from './routes/mcp';
import { registerRootRoutes } from './routes/root';
import type { StorageAdapter } from './storage/types';
import type { ApiConfig } from './types/api';
import type { AppEnv } from './types/http';

// -- app factory --------------------------------------------------------------

export type AppOptions = {
    config: ApiConfig;
    storage: StorageAdapter;
    keyCache?: KeyCache;
};

export function createApp(options: AppOptions) {
    const app = new Hono<AppEnv>();

    app.use('*', corsMiddleware);
    app.use('*', databaseMiddleware(options.storage, options.config));

    registerAuthMiddleware(app, { keyCache: options.keyCache });
    registerRootRoutes(app);
    registerKeyRoutes(app);
    registerContextRoutes(app);
    registerMcpRoutes(app);

    return app;
}
