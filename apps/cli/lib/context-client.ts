// =============================================================================
// context-client — the client-agnostic interface every context verb talks to.
// LocalContextClient (sqlite + @ultracontext/core) and RemoteContextClient
// (@ultracontext/js → hosted API) both implement it.
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

// add: append messages to the resolved context (or an explicit id)
export type AddInput = { id?: string; messages: Message[]; metadata?: Record<string, unknown> };

// get: read a context's messages, optionally at a past version/index
export type GetInput = { id?: string; version?: number; at?: number; before?: string; history?: boolean };

// update: patch messages by id or index (copy-on-write → new version)
export type UpdateInput = { id?: string; updates: Array<Record<string, unknown>>; metadata?: Record<string, unknown> };

// delete: drop a whole context (permanent), or specific messages by id/index
export type DeleteInput = { id?: string; permanent?: boolean; ids?: (string | number)[] };

// list: filter the project's contexts
export type ListInput = { limit?: number; source?: string; project_path?: string; session_id?: string };

// -- command outputs ----------------------------------------------------------

// add → the created/appended messages + the resulting version + the context id
export type AddResult = { data: MessageView[]; version: number; id: string };

// get → the context's messages at the selected version
export type GetResult = { data: MessageView[]; version: number };

// update → the updated messages + the new version
export type UpdateResult = { data: MessageView[]; version: number };

// delete → confirmation of the removed context
export type DeleteResult = { deleted: true; id: string };

// list → the project's contexts (newest first)
export type ListResult = { data: Array<{ id: string; metadata: Record<string, unknown>; created_at: string }> };

// -- the port -----------------------------------------------------------------

// same surface regardless of local vs remote backing store
export interface ContextClient {
    add(input: AddInput): Promise<AddResult>;
    get(input: GetInput): Promise<GetResult>;
    update(input: UpdateInput): Promise<UpdateResult>;
    delete(input: DeleteInput): Promise<DeleteResult>;
    list(input: ListInput): Promise<ListResult>;
}
