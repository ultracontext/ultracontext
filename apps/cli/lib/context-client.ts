// =============================================================================
// context-client — the client-agnostic interface every context verb talks to.
// LocalContextClient (sqlite + @ultracontext/core) and RemoteContextClient
// (@ultracontext/js → hosted API) both implement it.
// =============================================================================

// -- command inputs/outputs ---------------------------------------------------

// minimal shapes the verbs need; refined as commands are implemented
export type AddInput = { messages: unknown[]; metadata?: Record<string, unknown> };
export type GetInput = { id: string; version?: number };
export type UpdateInput = { id: string; updates: unknown[]; metadata?: Record<string, unknown> };
export type DeleteInput = { id: string; permanent?: boolean };
export type ListInput = { limit?: number; source?: string };

// -- the port -----------------------------------------------------------------

// same surface regardless of local vs remote backing store
export interface ContextClient {
    add(input: AddInput): Promise<unknown>;
    get(input: GetInput): Promise<unknown>;
    update(input: UpdateInput): Promise<unknown>;
    delete(input: DeleteInput): Promise<unknown>;
    list(input: ListInput): Promise<unknown>;
}
