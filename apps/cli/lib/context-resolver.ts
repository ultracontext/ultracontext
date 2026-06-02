// =============================================================================
// context-resolver — the local project + the default context for a cwd.
// Local storage holds a single project; the default context is keyed by a
// `project_path` metadata tag (= cwd), resolved-or-created on demand.
// =============================================================================

import type { StorageAdapter } from '@ultracontext/core';
import { createContext, listContexts } from '@ultracontext/core';

// -- local project ------------------------------------------------------------

// the one project id every local context lives under (memoized per adapter)
const projectCache = new WeakMap<StorageAdapter, number>();

// ensure the single local project exists; return its id (idempotent)
export async function ensureProject(storage: StorageAdapter): Promise<number> {
    // reuse the id we already created for this adapter, if any
    const cached = projectCache.get(storage);
    if (cached !== undefined) return cached;

    // create the local project row and remember its id
    const project = await storage.insertProject('local');
    if (!project) throw new Error('failed to create local project');

    projectCache.set(storage, project.id);
    return project.id;
}

// -- default context ----------------------------------------------------------

// resolve-or-create the default context for a cwd, tagged by project_path
export async function resolveDefaultContext(
    storage: StorageAdapter,
    projectId: number,
    cwd: string,
): Promise<string> {
    // existing default for this cwd? return its root id
    const existing = await listContexts(storage, projectId, { project_path: cwd, limit: 1 });
    if (existing.data.length > 0) return existing.data[0].id;

    // none yet — create one tagged with the cwd
    const created = await createContext(storage, projectId, { metadata: { project_path: cwd } });
    if (!created.ok) throw new Error(created.message);

    return created.data.id;
}
