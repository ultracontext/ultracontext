import type { StorageAdapter } from '../storage';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords } from '../context-chain';

// -- seed options -------------------------------------------------------------

export type SeedContextOptions = {
    messages?: object[];
    metadata?: object;
};

// -- seed result --------------------------------------------------------------

export type SeedContextResult = {
    rootId: string;
    headId: string;
    messageIds: string[];
};

// -- fixture factory ----------------------------------------------------------
// Mirrors what the createContext capability produces: a root context node, an
// initial head node (metadata { operation: 'create' }), and message nodes
// linked under the head by prev_id. Lets op tests skip sibling-op dependencies.

export async function seedContext(
    storage: StorageAdapter,
    projectId: number,
    opts: SeedContextOptions = {},
): Promise<SeedContextResult> {
    // insert root context node
    const rootId = generatePublicId('context');
    await storage.insertNodes({
        public_id: rootId,
        project_id: projectId,
        type: 'context',
        context_id: null,
        parent_id: null,
        content: {},
        metadata: (opts.metadata ?? {}) as Record<string, unknown>,
    });

    // insert initial head node under the root
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: null,
        content: {},
        metadata: { operation: 'create' },
    });

    // insert message nodes linked under the head
    const messageIds: string[] = [];
    const messages = opts.messages ?? [];
    if (messages.length > 0) {
        const nodeInputs = messages.map((m) => ({
            type: 'message',
            content: m as Record<string, unknown>,
            metadata: {},
        }));
        const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
        await storage.insertNodes(insertRecords);
        messageIds.push(...insertRecords.map((r) => r.public_id));
    }

    return { rootId, headId, messageIds };
}
