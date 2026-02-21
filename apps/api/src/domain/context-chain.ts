import { and, asc, eq, ne } from 'drizzle-orm';

import { nodes, type ApiDb } from '../db';
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

export async function findTail(db: ApiDb, contextPublicId: string): Promise<string | null> {
    const contextNodes = await db
        .select({ public_id: nodes.public_id, prev_id: nodes.prev_id })
        .from(nodes)
        .where(eq(nodes.context_id, contextPublicId));

    if (contextNodes.length === 0) return null;

    const pointedTo = new Set(contextNodes.map((n) => n.prev_id).filter(Boolean));
    const tail = contextNodes.find((n) => !pointedTo.has(n.public_id));

    return tail?.public_id ?? null;
}

export async function findHead(db: ApiDb, rootId: string): Promise<BranchNode | null> {
    const branches = await db
        .select({ public_id: nodes.public_id, prev_id: nodes.prev_id, created_at: nodes.created_at })
        .from(nodes)
        .where(and(eq(nodes.context_id, rootId), eq(nodes.type, 'context')));

    if (branches.length === 0) return null;

    const pointedTo = new Set(branches.map((b) => b.prev_id).filter(Boolean));
    const heads = branches.filter((b) => !pointedTo.has(b.public_id));

    return heads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;
}

export async function getOrderedNodes(db: ApiDb, headId: string) {
    const contextNodes = await db.select().from(nodes).where(and(eq(nodes.context_id, headId), ne(nodes.type, 'context')));

    if (contextNodes.length === 0) return [];
    return orderNodes(contextNodes as Array<{ public_id: string; prev_id: string | null; created_at: string }>);
}

export async function getVersions(db: ApiDb, rootId: string): Promise<VersionInfo[]> {
    const versions = await db
        .select({ public_id: nodes.public_id, created_at: nodes.created_at, metadata: nodes.metadata })
        .from(nodes)
        .where(and(eq(nodes.context_id, rootId), eq(nodes.type, 'context')))
        .orderBy(asc(nodes.created_at));

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
