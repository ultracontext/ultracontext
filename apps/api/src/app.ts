import { Hono } from 'hono';

import { registerAuthMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { databaseMiddleware } from './middleware/database';
import { registerContextRoutes } from './routes/contexts';
import { registerKeyRoutes } from './routes/keys';
import { registerRootRoutes } from './routes/root';
import type { AppEnv } from './types/http';

export function createApp() {
    const app = new Hono<AppEnv>();

    app.use('*', corsMiddleware);
    app.use('*', databaseMiddleware);

    registerAuthMiddleware(app);
    registerRootRoutes(app);
    registerKeyRoutes(app);
    registerContextRoutes(app);

    return app;
}

const app = createApp();

export default app;
