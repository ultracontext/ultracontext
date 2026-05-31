// =============================================================================
// DELETE CONTEXT — permanent (history-wiping) delete of a context
// Ported from DELETE /contexts/:id permanent path in apps/api routes.
// =============================================================================

import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- permanent-delete helper --------------------------------------------------

async function permanentlyDelete(storage: StorageAdapter, projectId: number, rootPublicId: string) {
    const branches = await storage.findContextBranches(rootPublicId);

    // Per branch: batch-clear parent refs for its messages, then delete them
    for (const branch of branches) {
        const messages = await storage.findNonContextNodes(branch.public_id);
        const msgIds = messages.map((m) => m.public_id);
        await storage.clearParentReferencesBulk(projectId, msgIds);
        await storage.clearParentReferences(projectId, branch.public_id);
        await storage.deleteNodesByContextId(projectId, branch.public_id);
    }

    // Clear parent refs pointing to root (forked contexts)
    await storage.clearParentReferences(projectId, rootPublicId);

    // Delete version head nodes
    await storage.deleteNodesByContextId(projectId, rootPublicId);

    // Delete the root node itself
    await storage.deleteNodeByPublicId(projectId, rootPublicId);
}

// -- op params ----------------------------------------------------------------

export type DeleteContextParams = {
    auditMetadata?: Record<string, unknown>;
};

// -- op -----------------------------------------------------------------------

export async function deleteContextPermanent(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    params: DeleteContextParams,
): Promise<Result<{ deleted: true; id: string; metadata?: Record<string, unknown> }>> {
    // audit metadata is optional and echoed verbatim on success
    const { auditMetadata } = params;

    // resolve the root context scoped to the project — missing -> 404 -> not_found
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    try {
        // wipe the whole context inside a serializable tx (append-vs-delete safety)
        await storage.transaction((tx) => permanentlyDelete(tx, projectId, root.public_id), { isolationLevel: 'serializable' });
        return ok({ deleted: true, id: contextId, ...(auditMetadata ? { metadata: auditMetadata } : {}) });
    } catch (error) {
        // tx failure -> 500 -> internal, preserving the thrown message verbatim
        const message = error instanceof Error ? error.message : 'Failed to delete context';
        return err('internal', message);
    }
}
