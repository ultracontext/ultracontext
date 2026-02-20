import { eq } from 'drizzle-orm';

import { KEY_PREFIX_LEN } from '../constants';
import { api_keys, projects } from '../db';
import { generateKey, hashKey } from '../domain/api-keys';
import type { HttpApp } from '../types/http';
import { firstRow } from '../utils/first-row';

export function registerKeyRoutes(app: HttpApp) {
    app.post('/v1/keys', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const { name } = body;

        if (!name || typeof name !== 'string') {
            return c.json({ error: 'name is required' }, 400);
        }

        const db = c.get('db');
        const project = firstRow(
            await db
                .insert(projects)
                .values({ name })
                .returning({ id: projects.id })
        );

        if (!project) return c.json({ error: 'Failed to create project' }, 500);

        try {
            const raw = generateKey();
            const prefix = raw.slice(0, KEY_PREFIX_LEN);
            const hash = await hashKey(raw);

            await db.insert(api_keys).values({ project_id: project.id, key_prefix: prefix, key_hash: hash });
            return c.json({ key: raw, prefix, project_id: project.id });
        } catch {
            try {
                await db.delete(projects).where(eq(projects.id, project.id));
            } catch (rollbackError) {
                const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                console.error(`Rollback failed for project ${project.id}: ${message}`);
            }
            return c.json({ error: 'Failed to create key' }, 500);
        }
    });
}
