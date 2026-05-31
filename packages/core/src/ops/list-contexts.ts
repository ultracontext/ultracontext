// =============================================================================
// LIST CONTEXTS — list a project's root contexts with optional filters
// =============================================================================

import type { StorageAdapter, ContextFilters } from '../storage';

// list root contexts (newest first), mapped to the public response shape
export async function listContexts(
    storage: StorageAdapter,
    projectId: number,
    filters: ContextFilters & { limit?: number },
) {
    const limit = filters.limit ?? 20;
    const data = await storage.listRootContexts(projectId, limit, filters);

    return {
        data: data.map(n => ({
            id: n.public_id,
            metadata: n.metadata,
            created_at: n.created_at,
        })),
    };
}
