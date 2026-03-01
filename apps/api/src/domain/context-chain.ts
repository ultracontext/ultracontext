import type { StorageAdapter } from '../storage/types';
import { generatePublicId } from './public-ids';

export type NodeInsertInput = {
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    parent_id?: string | null;
};

export type VersionInfo = {
    version: number;
    head_id: string;
    created_at: string;
    operation: 'create' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

type BranchNode = { public_id: string; prev_id: string | null; created_at: string };

// -- pure functions (no DB) ---------------------------------------------------

export function orderNodes<T extends { public_id: string; prev_id: string | null; created_at: string }>(items: T[]): T[] {
    if (items.length === 0) return [];

    const byPrev = new Map<string | null, T>();
    for (const item of items) {
        byPrev.set(item.prev_id, item);
    }

    const ordered: T[] = [];
    let current = byPrev.get(null);

    while (current) {
        ordered.push(current);
        current = byPrev.get(current.public_id);
    }

    if (ordered.length !== items.length) {
        console.error(`Broken linked list in context. Expected ${items.length} nodes, got ${ordered.length}. Falling back to created_at order.`);
        return [...items].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }

    return ordered;
}

export function buildNodeInsertRecords(nodesToInsert: NodeInsertInput[], projectId: number, contextId: string, startingPrevId: string | null = null) {
    const publicIds = nodesToInsert.map((n) => (n.type === 'context' ? generatePublicId('context') : generatePublicId('msg')));

    return nodesToInsert.map((node, idx) => ({
        public_id: publicIds[idx],
        project_id: projectId,
        type: node.type,
        context_id: contextId,
        prev_id: idx === 0 ? startingPrevId : publicIds[idx - 1],
        parent_id: node.parent_id,
        content: node.content,
        metadata: node.metadata,
    }));
}

// -- storage-backed functions -------------------------------------------------

export async function findTail(storage: StorageAdapter, contextPublicId: string): Promise<string | null> {
    const contextNodes = await storage.findNodesByContextId(contextPublicId);

    if (contextNodes.length === 0) return null;

    const pointedTo = new Set(contextNodes.map((n) => n.prev_id).filter(Boolean));
    const tail = contextNodes.find((n) => !pointedTo.has(n.public_id));

    return tail?.public_id ?? null;
}

export async function findHead(storage: StorageAdapter, rootId: string): Promise<BranchNode | null> {
    const branches = await storage.findContextBranches(rootId);

    if (branches.length === 0) return null;

    const pointedTo = new Set(branches.map((b) => b.prev_id).filter(Boolean));
    const heads = branches.filter((b) => !pointedTo.has(b.public_id));

    return heads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;
}

export async function getOrderedNodes(storage: StorageAdapter, headId: string) {
    const contextNodes = await storage.findNonContextNodes(headId);

    if (contextNodes.length === 0) return [];
    return orderNodes(contextNodes);
}

export async function getVersions(storage: StorageAdapter, rootId: string): Promise<VersionInfo[]> {
    const versions = await storage.findVersions(rootId);

    return versions.map((head, index: number) => {
        const meta = (head.metadata as Record<string, unknown>) ?? {};
        const { operation, affected, ...userMetadata } = meta;

        return {
            version: index,
            head_id: head.public_id,
            created_at: head.created_at,
            operation: (operation as 'create' | 'update' | 'delete') ?? 'create',
            affected: (affected as string[]) ?? null,
            metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
        };
    });
}
