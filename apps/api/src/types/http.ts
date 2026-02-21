import type { Context, MiddlewareHandler } from 'hono';

import type { ApiDb } from '../db';
import type { ApiConfig, Auth } from './api';

export type AppVariables = {
    auth: Auth;
    db: ApiDb;
    config: ApiConfig;
};

export type AppEnv = {
    Variables: AppVariables;
};

export type HttpContext = Context<AppEnv>;
export type HttpMiddleware = MiddlewareHandler<AppEnv>;
type HttpRouteHandler = (c: HttpContext) => Response | Promise<Response>;

export type HttpApp = {
    use(path: string, ...handlers: HttpMiddleware[]): unknown;
    get(path: string, handler: HttpRouteHandler): unknown;
    post(path: string, handler: HttpRouteHandler): unknown;
    patch(path: string, handler: HttpRouteHandler): unknown;
    delete(path: string, handler: HttpRouteHandler): unknown;
};
