// =============================================================================
// CREATE CONTEXT — create a root context, optionally forking a source (ported
// from POST /contexts)
// =============================================================================

import type { StorageAdapter, NodeRow } from '../storage';
import { buildNodeInsertRecords, findHead, getOrderedNodes, getVersions } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { firstRow } from '../first-row';
import { ok, err, type Result } from '../result';

// -- input --------------------------------------------------------------------

export type CreateContextInput = {
    from?: string;
    version?: unknown;
    at?: unknown;
    before?: unknown;
    metadata?: Record<string, unknown>;
};

// -- rollback helpers ---------------------------------------------------------

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

async function rollbackRootContext(storage: StorageAdapter, projectId: number, rootId: string, headId: string) {
    await rollbackHead(storage, projectId, headId);

    try {
        await storage.deleteNodesByContextId(projectId, rootId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for branches of root ${rootId}: ${message}`);
    }

    try {
        await storage.deleteNodeByPublicId(projectId, rootId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for root ${rootId}: ${message}`);
    }
}

// -- op -----------------------------------------------------------------------

export async function createContext(
    storage: StorageAdapter,
    projectId: number,
    input: CreateContextInput
): Promise<Result<{ id: string; metadata: Record<string, unknown>; created_at: string }>> {
    const { from, version, at, before, metadata } = input;

    // parse the optional `before` cutoff before anything else
    let beforeTs: number | undefined;
    if (before !== undefined) {
        beforeTs = Date.parse(before as string);
        if (isNaN(beforeTs)) return err('invalid_input', 'Invalid timestamp format');
    }

    // version/at/before are only meaningful when forking a source
    if ((version !== undefined || at !== undefined || before !== undefined) && !from) {
        return err('invalid_input', 'version, at, and before require from');
    }

    // resolve the source nodes to copy when forking
    let sourceNodes: NodeRow[] = [];
    if (from) {
        const sourceCtx = await storage.findRootContextByPublicId(from);
        if (!sourceCtx) return err('not_found', 'Source context not found');

        // pick the source head — by version index, by timestamp, or latest
        let sourceHead;
        const versions = await getVersions(storage, from);

        if (version !== undefined) {
            const versionNum = parseInt(String(version));
            if (isNaN(versionNum) || versionNum < 0 || versionNum >= versions.length) {
                return err('not_found', 'Version not found');
            }
            sourceHead = { public_id: versions[versionNum].head_id };
        } else if (beforeTs !== undefined) {
            const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs).pop();
            if (!targetVersion) return err('not_found', 'No version found before timestamp');
            sourceHead = { public_id: targetVersion.head_id };
        } else {
            sourceHead = await findHead(storage, from);
        }

        // gather + filter + slice the source nodes off the chosen head
        if (sourceHead) {
            sourceNodes = await getOrderedNodes(storage, sourceHead.public_id);

            if (beforeTs !== undefined) {
                sourceNodes = sourceNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs);
            }

            if (at !== undefined) {
                const idx = parseInt(String(at));
                if (isNaN(idx) || idx < 0 || idx >= sourceNodes.length) {
                    return err('invalid_input', 'Invalid index');
                }
                sourceNodes = sourceNodes.slice(0, idx + 1);
            }
        }
    }

    // create root node
    const rootId = generatePublicId('context');
    const rootRows = await storage.insertNodes({
        public_id: rootId,
        project_id: projectId,
        type: 'context',
        context_id: null,
        parent_id: from ?? null,
        content: {},
        metadata: (metadata ?? {}) as Record<string, unknown>,
    });
    const root = firstRow(rootRows);
    if (!root) return err('internal', 'Failed to create context');

    // create initial head
    const headId = generatePublicId('context');
    try {
        await storage.insertNodes({
            public_id: headId,
            project_id: projectId,
            type: 'context',
            context_id: rootId,
            prev_id: null,
            content: {},
            metadata: { operation: 'create' },
        });
    } catch {
        // head failed — roll back the orphaned root, swallowing rollback errors
        try {
            await storage.deleteNodeByPublicId(projectId, rootId);
        } catch (rollbackError) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            console.error(`Rollback failed for root ${rootId}: ${message}`);
        }
        return err('internal', 'Failed to create context');
    }

    // copy source nodes if forking
    if (sourceNodes.length > 0) {
        const nodeInputs = sourceNodes.map((n) => ({
            type: 'message',
            content: n.content,
            metadata: n.metadata,
            parent_id: n.public_id,
        }));
        const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
        try {
            await storage.insertNodes(insertRecords);
        } catch {
            // copy failed — roll back root + head together
            await rollbackRootContext(storage, projectId, rootId, headId);
            return err('internal', 'Failed to copy source context');
        }
    }

    return ok({
        id: root.public_id!,
        metadata: root.metadata!,
        created_at: root.created_at!,
    });
}
