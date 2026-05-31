// =============================================================================
// DELETE MESSAGES — remove messages from a context by id or index
// (ported from the DELETE /contexts/:id message-delete path)
// =============================================================================

import { findHead, getOrderedNodes, getVersions } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { isPlainObject } from '../request-parsing';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- params -------------------------------------------------------------------

export type DeleteMessagesParams = {
    ids: (string | number)[];
    userMetadata?: Record<string, unknown>;
};

// -- rollback helper ----------------------------------------------------------
// Drop an orphaned version head (and any children) after a failed copy step.

async function rollbackHead(storage: StorageAdapter, projectId: number, headId: string) {
    try {
        await storage.deleteNodesByContextId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for children of head ${headId}: ${message}`);
    }

    try {
        await storage.deleteNodeByPublicId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for head ${headId}: ${message}`);
    }
}

// -- op -----------------------------------------------------------------------

export async function deleteMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    params: DeleteMessagesParams
): Promise<Result<{ data: MessageView[]; version: number }>> {
    const { ids, userMetadata } = params;

    // userMetadata, when present, must be a plain object
    if (userMetadata !== undefined && !isPlainObject(userMetadata)) {
        return err('invalid_input', 'metadata must be an object');
    }

    // ids must be supplied
    if (ids === undefined || ids === null) return err('invalid_input', 'ids is required');

    // normalize to an array and reject empty input
    const rawIds: Array<string | number> = Array.isArray(ids) ? ids : [ids];
    if (rawIds.length === 0) return err('invalid_input', 'ids must be a non-empty array');

    // each element must be a string id or an integer index
    for (const input of rawIds) {
        if (typeof input === 'string') continue;
        if (typeof input !== 'number' || !Number.isInteger(input)) {
            return err('invalid_input', 'Each id must be a string or integer index');
        }
    }

    // resolve the root context, scoped to the project
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    // resolve the current head of the version chain
    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return err('internal', 'HEAD not found');

    // load the ordered messages under the current head
    const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);
    const nodeIds = new Set(orderedNodes.map((n) => n.public_id));

    // resolve each target to a concrete message public id
    const idsToDelete: string[] = [];
    for (const input of rawIds) {
        if (typeof input === 'string') {
            if (!nodeIds.has(input)) return err('not_found', `Message not found: ${input}`);
            idsToDelete.push(input);
        } else {
            let idx = input;
            if (idx < 0) idx = orderedNodes.length + idx;
            if (idx < 0 || idx >= orderedNodes.length) return err('invalid_input', `Index out of range: ${input}`);
            idsToDelete.push(orderedNodes[idx].public_id);
        }
    }
    const deleteSet = new Set(idsToDelete);

    // create new version head
    const newHeadId = generatePublicId('context');
    try {
        await storage.insertNodes({
            public_id: newHeadId,
            project_id: projectId,
            type: 'context',
            context_id: root.public_id,
            prev_id: currentHead.public_id,
            content: {},
            metadata: { operation: 'delete', affected: idsToDelete, ...(userMetadata ?? {}) },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create version head';
        return err('internal', message);
    }

    // build filtered node copies (copy-on-write of the survivors)
    const filtered = orderedNodes.filter((n) => !deleteSet.has(n.public_id));
    const newNodes = filtered.map((n) => ({
        public_id: generatePublicId('msg'),
        project_id: projectId,
        type: 'message',
        context_id: newHeadId,
        parent_id: n.public_id,
        prev_id: null as string | null,
        content: n.content,
        metadata: n.metadata,
    }));

    // link the copies in order via prev_id
    for (let i = 1; i < newNodes.length; i++) {
        newNodes[i].prev_id = newNodes[i - 1].public_id;
    }

    // persist the survivors, rolling back the orphaned head on failure
    if (newNodes.length > 0) {
        try {
            await storage.insertNodes(newNodes);
        } catch {
            await rollbackHead(storage, projectId, newHeadId);
            return err('internal', 'Failed to delete messages');
        }
    }

    // recompute the current version after the delete head landed
    const versions = await getVersions(storage, root.public_id);
    const currentVersion = versions.length - 1;
    const result: MessageView[] = newNodes.map((n, index: number) => ({
        ...n.content,
        id: n.public_id,
        index,
        metadata: n.metadata,
    }));

    return ok({ data: result, version: currentVersion });
}
