// =============================================================================
// STORAGE ADAPTER — abstracts all DB operations behind a common interface
// =============================================================================

// -- Row types (DB-agnostic) --------------------------------------------------

export type NodeRow = {
    id: number;
    public_id: string;
    project_id: number;
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
    parent_id: string | null;
    prev_id: string | null;
    context_id: string | null;
};

export type NodeInsertRow = {
    public_id: string;
    project_id: number;
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    context_id?: string | null;
    parent_id?: string | null;
    prev_id?: string | null;
};

export type ApiKeyRow = {
    id: number;
    project_id: number;
    key_hash: string;
};

export type ProjectRow = {
    id: number;
};

// -- Storage adapter interface ------------------------------------------------

export interface StorageAdapter {
    // nodes — queries
    findNodesByContextId(contextId: string, columns?: (keyof NodeRow)[]): Promise<Partial<NodeRow>[]>;
    findContextBranches(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'prev_id' | 'created_at'>[]>;
    findVersions(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'created_at' | 'metadata'>[]>;
    findNonContextNodes(contextId: string): Promise<NodeRow[]>;
    findRootContext(projectId: number, publicId: string): Promise<Pick<NodeRow, 'public_id'> | null>;
    findRootContextByPublicId(publicId: string): Promise<Pick<NodeRow, 'public_id'> | null>;
    listRootContexts(projectId: number, limit: number): Promise<Pick<NodeRow, 'public_id' | 'metadata' | 'created_at'>[]>;

    // nodes — mutations
    insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]>;
    deleteNodesByContextId(projectId: number, contextId: string): Promise<void>;
    deleteNodeByPublicId(projectId: number, publicId: string): Promise<void>;

    // api keys
    findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
    insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }): Promise<void>;

    // projects
    insertProject(name: string): Promise<ProjectRow | null>;
    deleteProject(id: number): Promise<void>;
}
