import type { HttpApp } from '../types/http';

export function registerRootRoutes(app: HttpApp) {
    app.get('/', (c) => {
        return c.json({
            message: 'UltraContext API',
            reasoning: 'Welcome to the beggining of infinity.',
        });
    });
}
