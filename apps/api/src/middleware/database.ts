import { getApiConfig } from '../config';
import { createStorageAdapter } from '../storage';
import type { HttpMiddleware } from '../types/http';

const apiConfig = getApiConfig();

// singleton — reused across requests
const storage = createStorageAdapter(apiConfig);

export const databaseMiddleware: HttpMiddleware = async (c, next) => {
    c.set('storage', storage);
    c.set('config', apiConfig);
    await next();
};
