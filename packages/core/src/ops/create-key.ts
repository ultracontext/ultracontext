// =============================================================================
// CREATE KEY — provision a project + API key (ported from POST /v1/keys)
// =============================================================================

import { KEY_PREFIX_LEN } from '../constants';
import { generateKey, hashKey } from '../api-keys';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- op -----------------------------------------------------------------------

export async function createKey(
    storage: StorageAdapter,
    name: string
): Promise<Result<{ key: string; prefix: string; project_id: number }>> {
    // name is required and must be a string
    if (!name || typeof name !== 'string') {
        return err('invalid_input', 'name is required');
    }

    // create the owning project first
    const project = await storage.insertProject(name);
    if (!project) return err('internal', 'Failed to create project');

    try {
        // generate the raw key, derive its prefix, and persist only the hash
        const raw = generateKey();
        const prefix = raw.slice(0, KEY_PREFIX_LEN);
        const hash = await hashKey(raw);

        await storage.insertApiKey({ project_id: project.id, key_prefix: prefix, key_hash: hash });
        return ok({ key: raw, prefix, project_id: project.id });
    } catch {
        // key creation failed — roll the project back, swallowing rollback errors
        try {
            await storage.deleteProject(project.id);
        } catch (rollbackError) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            console.error(`Rollback failed for project ${project.id}: ${message}`);
        }
        return err('internal', 'Failed to create key');
    }
}
