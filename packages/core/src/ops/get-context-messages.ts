// =============================================================================
// GET CONTEXT MESSAGES — current-version messages of a context (simple read)
// =============================================================================

import type { StorageAdapter } from '../storage';
import { findHead, getOrderedNodes } from '../context-chain';

// resolve the context's HEAD and return its ordered messages; null if missing
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
