import { serve } from '@hono/node-server';

import { createApp } from './app';
import { getApiConfig } from './config.node';
import { createStorageAdapter } from './storage';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
const storage = createStorageAdapter(config);
const app = createApp({ config, storage });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });

console.log(`UltraContext API listening on http://127.0.0.1:${port}`);
