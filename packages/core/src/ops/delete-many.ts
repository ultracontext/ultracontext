// =============================================================================
// DELETE-MANY — batch permanent delete of contexts (pure capability)
// =============================================================================

import { MAX_BATCH_DELETE } from '../constants';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- result shape -------------------------------------------------------------

export type DeleteResult = { id: string; deleted: boolean; error?: string };

export type DeleteManyResult = { results: DeleteResult[]; deleted_count: number };

// -- permanently delete a single root context and its history -----------------
// Wipes every branch's messages, the version head nodes, forked parent refs,
// and finally the root node itself — all within the caller's transaction.

async function permanentlyDelete(storage: StorageAdapter, projectId: number, rootPublicId: string) {
    const branches = await storage.findContextBranches(rootPublicId);

    // per branch: batch-clear parent refs for its messages, then delete them
    for (const branch of branches) {
        const messages = await storage.findNonContextNodes(branch.public_id);
        const msgIds = messages.map((m) => m.public_id);
        await storage.clearParentReferencesBulk(projectId, msgIds);
        await storage.clearParentReferences(projectId, branch.public_id);
        await storage.deleteNodesByContextId(projectId, branch.public_id);
    }

    // clear parent refs pointing to root (forked contexts)
    await storage.clearParentReferences(projectId, rootPublicId);

    // delete version head nodes
    await storage.deleteNodesByContextId(projectId, rootPublicId);

    // delete the root node itself
    await storage.deleteNodeByPublicId(projectId, rootPublicId);
}

// -- deleteManyContexts -------------------------------------------------------

export async function deleteManyContexts(
    storage: StorageAdapter,
    projectId: number,
    ids: string[],
): Promise<Result<DeleteManyResult>> {
    // ids must be a non-empty array
    if (!Array.isArray(ids) || ids.length === 0) {
        return err('invalid_input', 'ids must be a non-empty array of context IDs');
    }

    // batch ceiling
    if (ids.length > MAX_BATCH_DELETE) {
        return err('invalid_input', `ids must contain at most ${MAX_BATCH_DELETE} items`);
    }

    // validate element types upfront — fail the whole request on any non-string
    for (const el of ids) {
        if (typeof el !== 'string') return err('invalid_input', 'Each id must be a string');
    }

    const results: DeleteResult[] = [];

    // per item: resolve root, then serializable permanent delete
    for (const contextId of ids) {
        const root = await storage.findRootContext(projectId, contextId);
        if (!root) {
            results.push({ id: contextId, deleted: false, error: 'Not found' });
            continue;
        }

        try {
            await storage.transaction((tx) => permanentlyDelete(tx, projectId, root.public_id), { isolationLevel: 'serializable' });
            results.push({ id: contextId, deleted: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            results.push({ id: contextId, deleted: false, error: message });
        }
    }

    // always ok — the route computes 200/207/500 from deleted_count
    const deleted_count = results.filter((r) => r.deleted).length;
    return ok({ results, deleted_count });
}
