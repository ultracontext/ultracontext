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
    context_id?: string
    data: Message[]
    version: number
}

export interface ContextHistoryEntry {
    id: string
    session_id: string
    version: number
    operation: string
    created_at: string
    current: boolean
}

export interface ContextHistory {
    data: ContextHistoryEntry[]
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
    endpoint?: string
    region?: string
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
    workspaces: WorkspacesApi
    sessions: SessionsApi
    artifacts: WorkspaceArtifactsApi
    fs: FileSystemApi
    search: SearchApi
    sync: SyncApi
}

export interface WorkspacesApi {
    create(input?: WorkspaceInput): Promise<WorkspaceSummary>
    list(): Promise<WorkspaceList>
}

export interface SessionsApi {
    create(input?: ContextInput): Promise<SessionHandle>
    get(id: string): Promise<SessionHandle>
    list(): Promise<ContextList>
    delete(id: string): Promise<DeleteResult>
    fork(sourceId: string, options?: ContextReadOptions & { metadata?: Metadata }): Promise<SessionHandle>
}

export interface SessionHandle extends SessionSummary {
    context: SessionContextApi
    artifacts: SessionArtifactsApi
    fs: SessionFileSystemApi
    delete(): Promise<DeleteResult>
    fork(options?: ContextReadOptions & { metadata?: Metadata }): Promise<SessionHandle>
    toJSON(): SessionSummary
}

export interface SessionContextApi {
    current(options?: ContextReadOptions): Promise<ContextResult>
    get(options?: ContextReadOptions): Promise<ContextResult>
    list(options?: ContextReadOptions): Promise<ContextResult>
    append(entries: Message | Message[]): Promise<ContextResult>
    update(update: ContextUpdate | ContextUpdate[], options?: ContextUpdateOptions): Promise<ContextResult>
    delete(target: ContextDeleteTarget | ContextDeleteTarget[], options?: ContextUpdateOptions): Promise<ContextResult>
    clear(options?: ContextUpdateOptions): Promise<ContextResult>
    history(): Promise<ContextHistory>
    restore(contextId: string, options?: ContextUpdateOptions): Promise<ContextResult>
}

export interface SessionArtifactsApi {
    create(input: ArtifactSaveInput): Promise<ArtifactMeta>
    list(): Promise<ArtifactList>
    get(pathOrId: string, options?: ArtifactReadOptions): Promise<ArtifactData>
    update(pathOrId: string, data: unknown, options?: ArtifactWriteOptions): Promise<ArtifactMeta>
    delete(pathOrId: string, options?: ArtifactRemoveOptions): Promise<DeleteResult>
}

export interface WorkspaceArtifactsApi {
    session(sessionId: string): SessionArtifactsApi
}

export interface FileSystemApi {
    session(sessionId: string): SessionFileSystemApi
}

export interface SessionFileSystemApi {
    list(options?: { prefix?: string }): Promise<ArtifactList>
    read(pathOrId: string, options?: ArtifactReadOptions): Promise<ArtifactData>
    write(path: string, data: unknown, options?: ArtifactWriteOptions): Promise<ArtifactMeta>
    move(fromPathOrId: string, toPath: string, options?: ArtifactMoveOptions): Promise<ArtifactMeta>
    remove(pathOrId: string, options?: ArtifactRemoveOptions): Promise<DeleteResult>
    glob(pattern: string, options?: ArtifactGlobOptions): Promise<ArtifactList>
    grep(query: string, options?: ArtifactGrepOptions): Promise<SearchResult>
}

export interface SyncApi {
    exportSnapshot(): Promise<Snapshot>
    importSnapshot(snapshot: Snapshot): Promise<ImportResult>
    exportChanges(options?: { since?: number }): Promise<Changes>
    importChanges(changes: Changes): Promise<ImportResult>
}

export interface SearchApi {
    query(query: string, options?: SearchOptions): Promise<SearchResult>
}

export interface UltraContextEngine {
    install?(): Awaitable<void>
    dispatch(operation: string, payload: Record<string, unknown>): Awaitable<unknown>
}
