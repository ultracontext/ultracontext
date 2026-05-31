import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow, ContextFilters } from '../storage';

// -- In-memory storage adapter ------------------------------------------------

type StoredNode = NodeRow;

export class MemoryStorage implements StorageAdapter {
    private nodes: StoredNode[] = [];
    private keys: Array<{ id: number; project_id: number; key_prefix: string; key_hash: string }> = [];
    private projectSeq = 0;
    private nodeSeq = 0;

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        return this.nodes
            .filter((n) => n.context_id === contextId)
            .map((n) => ({ public_id: n.public_id, prev_id: n.prev_id }));
    }

    async findContextBranches(contextId: string) {
        return this.nodes
            .filter((n) => n.context_id === contextId && n.type === 'context')
            .map((n) => ({ public_id: n.public_id, prev_id: n.prev_id, created_at: n.created_at }));
    }

    async findVersions(contextId: string) {
        return this.nodes
            .filter((n) => n.context_id === contextId && n.type === 'context')
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((n) => ({ public_id: n.public_id, created_at: n.created_at, metadata: n.metadata }));
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        return this.nodes.filter((n) => n.context_id === contextId && n.type !== 'context');
    }

    async findRootContext(projectId: number, publicId: string) {
        const n = this.nodes.find(
            (n) => n.project_id === projectId && n.public_id === publicId && n.type === 'context' && n.context_id === null
        );
        return n ? { public_id: n.public_id } : null;
    }

    async findRootContextByPublicId(publicId: string) {
        const n = this.nodes.find((n) => n.public_id === publicId && n.type === 'context' && n.context_id === null);
        return n ? { public_id: n.public_id } : null;
    }

    async listRootContexts(projectId: number, limit: number, _filters?: ContextFilters) {
        return this.nodes
            .filter((n) => n.project_id === projectId && n.type === 'context' && n.context_id === null)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit)
            .map((n) => ({ public_id: n.public_id, metadata: n.metadata, created_at: n.created_at }));
    }

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        const rows = Array.isArray(values) ? values : [values];
        const results: Partial<NodeRow>[] = [];
        for (const row of rows) {
            const node: StoredNode = {
                id: ++this.nodeSeq,
                public_id: row.public_id,
                project_id: row.project_id,
                type: row.type,
                content: row.content ?? {},
                metadata: row.metadata ?? {},
                created_at: new Date().toISOString(),
                parent_id: row.parent_id ?? null,
                prev_id: row.prev_id ?? null,
                context_id: row.context_id ?? null,
            };
            this.nodes.push(node);
            results.push({
                public_id: node.public_id,
                content: node.content,
                metadata: node.metadata,
                created_at: node.created_at,
            });
        }
        return results;
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        this.nodes = this.nodes.filter((n) => !(n.project_id === projectId && n.context_id === contextId));
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        this.nodes = this.nodes.filter((n) => !(n.project_id === projectId && n.public_id === publicId));
    }

    async clearParentReferences(projectId: number, parentId: string) {
        for (const n of this.nodes) {
            if (n.project_id === projectId && n.parent_id === parentId) {
                n.parent_id = null;
            }
        }
    }

    async clearParentReferencesBulk(projectId: number, parentIds: string[]) {
        if (parentIds.length === 0) return;
        const set = new Set(parentIds);
        for (const n of this.nodes) {
            if (n.project_id === projectId && n.parent_id && set.has(n.parent_id)) {
                n.parent_id = null;
            }
        }
    }

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const k = this.keys.find((k) => k.key_prefix === prefix);
        return k ? { id: k.id, project_id: k.project_id, key_hash: k.key_hash } : null;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        this.keys.push({ id: this.keys.length + 1, ...values });
    }

    async updateApiKeyLastUsedAt(_id: number, _lastUsedAt: string) {}

    async insertProject(name: string): Promise<ProjectRow | null> {
        return { id: ++this.projectSeq };
    }

    async deleteProject(_id: number) {}

    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: unknown): Promise<T> {
        return fn(this);
    }

    // test helpers
    getAllNodes() {
        return this.nodes;
    }

    getNodesByPublicId(publicId: string) {
        return this.nodes.find((n) => n.public_id === publicId) ?? null;
    }

    getNodesWithParentId(parentId: string) {
        return this.nodes.filter((n) => n.parent_id === parentId);
    }
}
