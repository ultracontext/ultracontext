import { getApiConfig } from '../config';
import { createDbClient } from '../db';
import type { HttpMiddleware } from '../types/http';

const apiConfig = getApiConfig();

export const databaseMiddleware: HttpMiddleware = async (c, next) => {
    const db = createDbClient(apiConfig.DATABASE_URL);
    c.set('db', db);
    c.set('config', apiConfig);
    await next();
};
