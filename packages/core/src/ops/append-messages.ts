// =============================================================================
// APPEND MESSAGES — append messages to a context (ported from POST /contexts/:id)
// =============================================================================

import { buildNodeInsertRecords, findHead, findTail, getOrderedNodes, getVersions } from '../context-chain';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- intermediate tx outcome --------------------------------------------------
// Mirrors the handler: the serializable tx returns either the success payload
// or an error marker carrying the original HTTP status, resolved to a Result
// once the tx completes.

type AppendOutcome = { data: MessageView[]; version: number } | { code: 'not_found' | 'internal'; message: string };

// -- op -----------------------------------------------------------------------

export async function appendMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    messages: object | object[],
): Promise<Result<{ data: MessageView[]; version: number }>> {
    // Serializable tx so concurrent permanent-delete can't race with append
    // (Postgres SSI makes one side fail with 40001; client retries).
    let outcome: AppendOutcome;
    try {
        outcome = await storage.transaction<AppendOutcome>(async (tx) => {
            // context must exist under this project
            const root = await tx.findRootContext(projectId, contextId);
            if (!root) return { code: 'not_found', message: 'Context not found' };

            // resolve the current head of the context chain
            const head = await findHead(tx, root.public_id);
            if (!head) return { code: 'internal', message: 'HEAD not found' };

            // normalize input to an array and locate the existing tail
            const items = Array.isArray(messages) ? messages : [messages];
            const existingNodes = await getOrderedNodes(tx, head.public_id);
            const existingCount = existingNodes.length;
            const tailPublicId = await findTail(tx, head.public_id);

            // split metadata out of each message; the rest is content
            const nodeInputs = items.map((msg) => {
                const { metadata, ...content } = msg as Record<string, unknown>;
                return { type: 'message', content, metadata: (metadata ?? {}) as Record<string, unknown> };
            });
            const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, head.public_id, tailPublicId);

            // append the new message nodes after the tail
            const createdNodes = await tx.insertNodes(insertRecords);

            // version reflects the current head count (append adds no new head)
            const versions = await getVersions(tx, root.public_id);
            const currentVersion = versions.length - 1;

            // shape each created node: content + generated id + index + metadata
            const data: MessageView[] = createdNodes.map((node, i: number) => ({
                ...(node.content ?? {}),
                id: node.public_id!,
                index: existingCount + i,
                metadata: node.metadata ?? {},
            }));

            return { data, version: currentVersion };
        }, { isolationLevel: 'serializable' });
    } catch {
        // any tx failure collapses to a single internal error
        return err('internal', 'Failed to append messages');
    }

    // resolve the intermediate error marker to a Result error
    if ('code' in outcome) return err(outcome.code, outcome.message);
    return ok({ data: outcome.data, version: outcome.version });
}
