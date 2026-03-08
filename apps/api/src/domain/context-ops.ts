import type { StorageAdapter, ContextFilters } from '../storage/types';
import { findHead, getOrderedNodes } from './context-chain';

// -- list contexts ------------------------------------------------------------

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

// -- get context messages -----------------------------------------------------

export async function getContextMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
) {
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return null;

    const head = await findHead(storage, root.public_id);
    if (!head) return { data: [] };

    const orderedNodes = await getOrderedNodes(storage, head.public_id);

    return {
        data: orderedNodes.map((n: any, index: number) => ({
            ...n.content,
            id: n.public_id,
            index,
            metadata: n.metadata,
        })),
    };
}
