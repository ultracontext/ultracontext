// =============================================================================
// context-resolver — the single local project under which all contexts live.
// Local storage holds one 'local' project (no key needed). There is NO default
// context: every verb targets an explicit context id (see lib/context-id.ts).
// =============================================================================

import type { StorageAdapter } from '@ultracontext/core';

// -- local project ------------------------------------------------------------

// the one project id every local context lives under (memoized per adapter)
const projectCache = new WeakMap<StorageAdapter, number>();

// adapters that can look up a project by name (sqlite) reuse the existing row
type ProjectLookupAdapter = StorageAdapter & { findProjectByName?(name: string): Promise<{ id: number } | null> };

// ensure the single local project exists; return its id (idempotent across connections)
export async function ensureProject(storage: StorageAdapter): Promise<number> {
    // reuse the id we already resolved for this adapter, if any
    const cached = projectCache.get(storage);
    if (cached !== undefined) return cached;

    // a fresh connection to an existing db must reuse the same 'local' project
    const existing = await (storage as ProjectLookupAdapter).findProjectByName?.('local');
    if (existing) {
        projectCache.set(storage, existing.id);
        return existing.id;
    }

    // none yet — create the local project row and remember its id
    const project = await storage.insertProject('local');
    if (!project) throw new Error('failed to create local project');

    projectCache.set(storage, project.id);
    return project.id;
}
