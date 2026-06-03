// =============================================================================
// context-client — the client-agnostic interface every context verb talks to.
// LocalContextClient (sqlite + @ultracontext/core) and RemoteContextClient
// (@ultracontext/js → hosted API) both implement it. Every targeted verb takes
// an EXPLICIT context id — there is no default context. The verb names mirror
// the SDK: create / append / get / update / delete / list.
// =============================================================================

// -- message shape ------------------------------------------------------------

// a single context message — free-form content plus optional metadata
export type Message = Record<string, unknown> & { metadata?: Record<string, unknown> };

// a message as stored — content fields plus a generated id + ordinal index
export type MessageView = Record<string, unknown> & {
    id: string;
    index: number;
    metadata: Record<string, unknown>;
};

// -- command inputs -----------------------------------------------------------

// create: make a new root context, or FORK from <from> (optionally at a past
// version/index/timestamp). metadata tags the CONTEXT itself.
export type CreateInput = {
    from?: string;
    version?: number;
    at?: number;
    before?: string;
    metadata?: Record<string, unknown>;
};

// append: add messages to an explicit context id (per-message metadata allowed)
export type AppendInput = { id: string; messages: Message[] };

// get: read a context's messages, optionally at a past version/index
export type GetInput = { id: string; version?: number; at?: number; before?: string; history?: boolean };

// update: patch messages by id or index (copy-on-write → new version). metadata
// tags the resulting VERSION.
export type UpdateInput = { id: string; updates: Array<Record<string, unknown>>; metadata?: Record<string, unknown> };

// delete: drop a whole context (permanent) or specific messages (--ids). metadata
// = audit metadata on a permanent delete, version metadata on a message delete.
export type DeleteInput = { id: string; permanent?: boolean; ids?: (string | number)[]; metadata?: Record<string, unknown> };

// deleteMany: batch-delete WHOLE contexts (always permanent). metadata is audit
// metadata applied to every delete in the batch.
export type DeleteManyInput = { ids: string[]; metadata?: Record<string, unknown> };

// list: filter the project's contexts. Mirrors core ContextFilters — every
// field maps to a column/json_extract the sqlite adapter genuinely filters on
// (source/user_id/host/project_path/session_id via metadata, after/before via
// created_at), so the SDK's full ListContextsInput forwards through with no drop.
export type ListInput = {
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
};

// -- command outputs ----------------------------------------------------------

// create → the new context id + its metadata + creation timestamp
export type CreateResult = { id: string; metadata: Record<string, unknown>; created_at: string };

// append → the created messages + the resulting version + the context id
export type AppendResult = { data: MessageView[]; version: number; id: string };

// a version-history entry, surfaced by get({ history: true })
export type VersionEntry = {
    version: number;
    created_at: string;
    operation: 'create' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

// get → the context's messages at the selected version (+ history when asked)
export type GetResult = { data: MessageView[]; version: number; versions?: VersionEntry[] };

// update → the updated messages + the new version
export type UpdateResult = { data: MessageView[]; version: number };

// delete → confirmation of the removed context, plus the audit/version metadata
// that core recorded (echoed back so a permanent delete's --meta is observable).
// A message-level (soft) delete is versioned: data/version carry the surviving
// messages + the new version so the unified SDK can mirror the remote soft-delete
// {data,version} shape. They stay absent on a whole-context permanent delete.
export type DeleteResult = {
    deleted: true;
    id: string;
    metadata?: Record<string, unknown>;
    data?: MessageView[];
    version?: number;
};

// deleteMany → one row per requested id (deleted true/false + an error reason on
// failure) plus a deleted_count summary. Mirrors the SDK's DeleteManyResponse so
// the unified facade can surface it verbatim. Partial failures never abort: every
// id gets a row regardless of whether its delete succeeded.
export type DeleteManyResult = {
    results: Array<{ id: string; deleted: boolean; error?: string }>;
    deleted_count: number;
};

// list → the project's contexts (newest first)
export type ListResult = { data: Array<{ id: string; metadata: Record<string, unknown>; created_at: string }> };

// -- the port -----------------------------------------------------------------

// same surface regardless of local vs remote backing store
export interface ContextClient {
    create(input: CreateInput): Promise<CreateResult>;
    append(input: AppendInput): Promise<AppendResult>;
    get(input: GetInput): Promise<GetResult>;
    update(input: UpdateInput): Promise<UpdateResult>;
    delete(input: DeleteInput): Promise<DeleteResult>;
    deleteMany(input: DeleteManyInput): Promise<DeleteManyResult>;
    list(input: ListInput): Promise<ListResult>;
}
