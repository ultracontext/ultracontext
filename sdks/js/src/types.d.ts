export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
    [key: string]: JsonValue | undefined
}

export type Awaitable<T> = T | Promise<T>
export type Metadata = Record<string, unknown>
export type NodeKind = 'workspace' | 'session' | 'context' | 'message' | 'artifact'

export interface UltraContextErrorOptions {
    code?: string
    status?: number
    body?: unknown
}

export interface UltraContextErrorShape {
    name: 'UltraContextError'
    code: string
    status?: number
    body?: unknown
    message: string
}

export interface WorkspaceInput {
    metadata?: Metadata
    [key: string]: unknown
}

export interface WorkspaceSummary {
    id: string
    metadata: Metadata
    created_at: string
}

export interface WorkspaceList {
    data: WorkspaceSummary[]
}

export interface SessionInput {
    metadata?: Metadata
    [key: string]: unknown
}

export interface SessionSummary {
    id: string
    workspace_id?: string
    context_id?: string
    metadata: Metadata
    created_at: string
}

export interface ContextInput {
    workspaceId?: string
    workspace_id?: string
    metadata?: Metadata
    [key: string]: unknown
}

export interface ContextSummary {
    id: string
    metadata: Metadata
    created_at: string
}

export interface ContextList {
    data: ContextSummary[]
}

export interface Message {
    id?: string
    role?: string
    content?: unknown
    metadata?: Metadata
    [key: string]: unknown
}

export interface ContextReadOptions {
    version?: number
}

export interface ContextResult {
    id?: string
    data: Message[]
    version: number
}

export interface ContextUpdate {
    id?: string
    index?: number
    [key: string]: unknown
}

export interface ContextUpdateOptions {
    metadata?: Metadata
    [key: string]: unknown
}

export type ContextDeleteTarget = string | number | { id?: string; index?: number; permanent?: boolean }

export interface DeleteResult {
    deleted: boolean
    id: string
}

export interface SearchOptions {
    [key: string]: unknown
}

export interface SearchHit {
    kind: 'message' | 'artifact' | string
    id: string
    context_id?: string
    path?: string | null
    snippet?: string
    metadata?: Metadata
    created_at?: string
}

export interface SearchResult {
    data: SearchHit[]
}

export interface ArtifactStorage {
    type: 'inline' | 'ref' | string
    driver?: string
    bucket?: string
    key?: string
    kind?: string
    [key: string]: unknown
}

export interface ArtifactSaveInput {
    id?: string
    path: string
    data?: unknown
    kind?: string
    mediaType?: string
    metadata?: Metadata
    ifVersion?: number
    [key: string]: unknown
}

export interface ArtifactMeta {
    id: string
    path: string
    kind: string
    version: number
    size?: number
    sha256?: string
    storage?: ArtifactStorage
    metadata?: Metadata
    created_at?: string
}

export interface ArtifactData extends ArtifactMeta {
    data: string
}

export interface ArtifactList {
    data: ArtifactMeta[]
}

export interface ArtifactReadOptions {
    version?: number
    [key: string]: unknown
}

export interface ArtifactWriteOptions {
    kind?: string
    mediaType?: string
    metadata?: Metadata
    ifVersion?: number
    [key: string]: unknown
}

export interface ArtifactMoveOptions {
    ifVersion?: number
    [key: string]: unknown
}

export interface ArtifactRemoveOptions {
    ifVersion?: number
    [key: string]: unknown
}

export interface ArtifactGlobOptions {
    [key: string]: unknown
}

export interface ArtifactGrepOptions {
    prefix?: string
    [key: string]: unknown
}

export interface NodeRecord {
    id: number
    public_id: string
    kind: NodeKind | string
    content: unknown
    metadata: Metadata
    data?: string | null
    prev?: number | null
    parent?: number | null
    owner?: number | null
    created_at: string
}

export interface Snapshot {
    schema: 'ultracontext.snapshot.v1'
    cursor: number
    nodes: NodeRecord[]
}

export interface Changes {
    schema: 'ultracontext.changes.v1'
    since: number
    cursor: number
    nodes: NodeRecord[]
}

export interface ImportResult {
    imported: number
    skipped: number
    conflicts: unknown[]
}

export interface UltraContextClient {
    createWorkspace(input?: WorkspaceInput): Promise<WorkspaceSummary>
    listWorkspaces(): Promise<WorkspaceList>
    createSession(workspaceId: string, input?: SessionInput): Promise<SessionSummary>
    create(input?: ContextInput): Promise<ContextSummary>
    fork(sourceId: string, options?: ContextReadOptions & { metadata?: Metadata }): Promise<ContextSummary>
    append(contextId: string, messages: Message | Message[]): Promise<ContextResult>
    get(): Promise<ContextList>
    get(contextId: string, options?: ContextReadOptions): Promise<ContextResult>
    update(contextId: string, updates: ContextUpdate | ContextUpdate[], options?: ContextUpdateOptions): Promise<ContextResult>
    delete(contextId: string, target: ContextDeleteTarget | ContextDeleteTarget[], options?: ContextUpdateOptions): Promise<DeleteResult | ContextResult>
    search(query: string, options?: SearchOptions): Promise<SearchResult>
    save(contextId: string, input: ArtifactSaveInput): Promise<ArtifactMeta>
    load(contextId: string): Promise<ArtifactList>
    load(contextId: string, pathOrId: string, options?: ArtifactReadOptions): Promise<ArtifactData>
    read(contextId: string, pathOrId: string, options?: ArtifactReadOptions): Promise<ArtifactData>
    write(contextId: string, path: string, data: unknown, options?: ArtifactWriteOptions): Promise<ArtifactMeta>
    move(contextId: string, fromPathOrId: string, toPath: string, options?: ArtifactMoveOptions): Promise<ArtifactMeta>
    remove(contextId: string, pathOrId: string, options?: ArtifactRemoveOptions): Promise<DeleteResult>
    glob(contextId: string, pattern: string, options?: ArtifactGlobOptions): Promise<ArtifactList>
    grep(contextId: string, query: string, options?: ArtifactGrepOptions): Promise<SearchResult>
    exportSnapshot(): Promise<Snapshot>
    importSnapshot(snapshot: Snapshot): Promise<ImportResult>
    exportChanges(options?: { since?: number }): Promise<Changes>
    importChanges(changes: Changes): Promise<ImportResult>
}

export interface UltraContextEngine {
    install?(): Awaitable<void>
    createWorkspace(input?: WorkspaceInput): Awaitable<WorkspaceSummary>
    listWorkspaces(): Awaitable<WorkspaceList>
    createSession(workspaceId: string, input?: SessionInput): Awaitable<SessionSummary>
    create(input?: ContextInput): Awaitable<ContextSummary>
    fork(sourceId: string, options?: ContextReadOptions & { metadata?: Metadata }): Awaitable<ContextSummary>
    append(contextId: string, messages: Message | Message[]): Awaitable<ContextResult>
    get(contextId: string, options?: ContextReadOptions): Awaitable<ContextResult>
    listContexts(): Awaitable<ContextList>
    update(contextId: string, updates: ContextUpdate | ContextUpdate[], options?: ContextUpdateOptions): Awaitable<ContextResult>
    delete(contextId: string, target: ContextDeleteTarget | ContextDeleteTarget[], options?: ContextUpdateOptions): Awaitable<DeleteResult | ContextResult>
    search(query: string, options?: SearchOptions): Awaitable<SearchResult>
    save(contextId: string, input: ArtifactSaveInput): Awaitable<ArtifactMeta>
    load(contextId: string, pathOrId: string, options?: ArtifactReadOptions): Awaitable<ArtifactData>
    listArtifacts(contextId: string): Awaitable<ArtifactList>
    read(contextId: string, pathOrId: string, options?: ArtifactReadOptions): Awaitable<ArtifactData>
    write(contextId: string, path: string, data: unknown, options?: ArtifactWriteOptions): Awaitable<ArtifactMeta>
    move(contextId: string, fromPathOrId: string, toPath: string, options?: ArtifactMoveOptions): Awaitable<ArtifactMeta>
    remove(contextId: string, pathOrId: string, options?: ArtifactRemoveOptions): Awaitable<DeleteResult>
    glob(contextId: string, pattern: string, options?: ArtifactGlobOptions): Awaitable<ArtifactList>
    grep(contextId: string, query: string, options?: ArtifactGrepOptions): Awaitable<SearchResult>
    exportSnapshot(options?: unknown): Awaitable<Snapshot>
    importSnapshot(snapshot: Snapshot): Awaitable<ImportResult>
    exportChanges(options?: { since?: number }): Awaitable<Changes>
    importChanges(changes: Changes): Awaitable<ImportResult>
}

export interface ContentStoreWriteInput {
    artifactId: string
    version: number
    data: unknown
    kind?: string
}

export interface ContentStore {
    driver?: string
    write(input: ContentStoreWriteInput): Awaitable<ArtifactStorage>
    read(storage: ArtifactStorage): Awaitable<string>
    exists?(storage: ArtifactStorage): Awaitable<boolean>
    put?(storage: ArtifactStorage, data: unknown): Awaitable<void>
    delete?(storage: ArtifactStorage): Awaitable<void>
}
