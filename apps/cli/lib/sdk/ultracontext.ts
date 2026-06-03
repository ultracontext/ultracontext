// =============================================================================
// UltraContext — the UNIFIED SDK facade. ONE class exposing EXACTLY the remote
// SDK's public signatures (create/append/get[list|single]/update/delete[soft|
// permanent]/deleteMany), backed LOCAL (sqlite + @ultracontext/core) or REMOTE
// (hosted API via @ultracontext/js). Local-by-default, remote opt-in:
//   mode ?? (apiKey ? 'remote' : 'local')
// The constructor is SYNC (Supabase-style `new UltraContext()`); the backend is
// built LAZILY on the first call (local must open sqlite async) and memoized.
// Local errors THROW (parity with remote, which throws on HTTP error).
// =============================================================================

import type {
    UltraContext as RemoteUltraContext,
    CreateContextInput, CreateContextResponse,
    AppendInput, AppendResponse,
    GetContextInput, GetContextResponse,
    ListContextsInput, ListContextsResponse,
    UpdateInput, UpdateResponse, MutationOptions,
    DeleteInput, DeleteResponse, DeletePermanentInput, PermanentDeleteResponse,
    DeleteManyResponse, DeleteManyResult,
} from '@ultracontext/js';

import type { ContextClient } from '../context-client';

// -- config -------------------------------------------------------------------

// every field optional — local-by-default; an apiKey infers remote. db is the
// LOCAL sqlite target (app-specific, default ./ultracontext.db in cwd). The
// remote fields (apiKey/baseUrl/fetch/headers/timeoutMs) mirror the remote SDK.
export type UltraContextConfig = {
    mode?: 'local' | 'remote';
    db?: string;
    apiKey?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
};

// -- backend port -------------------------------------------------------------

// the lazily-built backend: a remote SDK instance, or a local ContextClient
// tagged so the facade can adapt its object-arg verbs to the public signatures.
type Backend =
    | { kind: 'remote'; sdk: RemoteUltraContext }
    | { kind: 'local'; client: ContextClient };

// -- db url normalization -----------------------------------------------------

// a db string carrying a leading scheme (file:/libsql:/http — two+ chars before
// the colon) is used as-is; anything else is a local file path, `file:`-prefixed.
// A SINGLE-letter prefix (a Windows drive like C:) is a path, not a scheme. A
// multi-char leading token (`data:base.db`) still reads as a scheme — prefix
// `./` to force a path. Exported for tests; mirrored by the Python SDK.
export function toDbUrl(db: string): string {
    return /^[a-z][a-z0-9+.-]+:/i.test(db) ? db : `file:${db}`;
}

// -- facade -------------------------------------------------------------------

export class UltraContext {
    // resolved mode + the raw config (read lazily when the backend is built)
    private readonly mode: 'local' | 'remote';
    private readonly cfg: UltraContextConfig;

    // memoized backend promise — built on the FIRST method call, then reused
    private backend?: Promise<Backend>;

    // SYNC constructor: resolve the mode now, defer all IO to the first call
    constructor(cfg: UltraContextConfig = {}) {
        this.cfg = cfg;
        this.mode = cfg.mode ?? (cfg.apiKey ? 'remote' : 'local');
    }

    // -- backend resolution ---------------------------------------------------

    // build (once) + return the backend. REMOTE instantiates the @ultracontext/js
    // SDK (dynamically imported so a remote-only path still loads it lazily);
    // LOCAL dynamically imports the local client so remote-only consumers never
    // pull in core/storage/libsql.
    private resolve(): Promise<Backend> {
        if (this.backend) return this.backend;

        this.backend = this.mode === 'remote' ? this.resolveRemote() : this.resolveLocal();
        return this.backend;
    }

    // remote backend — needs an apiKey (a remote mode without one is a clear error)
    private async resolveRemote(): Promise<Backend> {
        if (!this.cfg.apiKey) {
            throw new Error("remote mode needs an api key — pass { apiKey } or use mode:'local'");
        }

        // dynamic import keeps the SDK off the import graph until a remote call
        const { UltraContext: RemoteSdk } = await import('@ultracontext/js');
        const sdk = new RemoteSdk({
            apiKey: this.cfg.apiKey,
            baseUrl: this.cfg.baseUrl,
            fetch: this.cfg.fetch,
            headers: this.cfg.headers,
            timeoutMs: this.cfg.timeoutMs,
        });
        return { kind: 'remote', sdk };
    }

    // local backend — opens the sqlite-backed ContextClient at the resolved db.
    // dynamic import so remote-only consumers never load core/storage/libsql.
    private async resolveLocal(): Promise<Backend> {
        const dbUrl = toDbUrl(this.cfg.db ?? 'ultracontext.db');
        const { createLocalClient } = await import('../clients/local');
        const client = await createLocalClient({ dbUrl, cwd: process.cwd() });
        return { kind: 'local', client };
    }

    // -- create ---------------------------------------------------------------

    // create a root context, or FORK via { from }. metadata tags the CONTEXT.
    async create(input: CreateContextInput = {}): Promise<CreateContextResponse> {
        const backend = await this.resolve();
        if (backend.kind === 'remote') return backend.sdk.create(input);

        // local ContextClient.create already returns {id, metadata, created_at}
        return backend.client.create(input);
    }

    // -- append ---------------------------------------------------------------

    // append one message or an ARRAY of messages in ONE call (one version bump).
    async append<T = unknown>(contextId: string, input: AppendInput): Promise<AppendResponse<T>> {
        const backend = await this.resolve();
        if (backend.kind === 'remote') return backend.sdk.append<T>(contextId, input);

        // adapt to the object-arg client: array stays an array, object → [object]
        const messages = Array.isArray(input) ? input : [input];
        const res = await backend.client.append({ id: contextId, messages });
        return { data: res.data, version: res.version } as AppendResponse<T>;
    }

    // -- get (overloaded: list | single) --------------------------------------

    // get() / get({filters}) → the LIST overload (all contexts in the project)
    async get(options?: ListContextsInput): Promise<ListContextsResponse>;
    // get(id, {selectors}) → the SINGLE-context overload (its messages/history)
    async get<T = unknown>(id: string, options?: GetContextInput): Promise<GetContextResponse<T>>;
    async get<T = unknown>(
        idOrOptions?: string | ListContextsInput,
        options?: GetContextInput,
    ): Promise<GetContextResponse<T> | ListContextsResponse> {
        const backend = await this.resolve();

        // SINGLE-context read when the first arg is an id string
        if (typeof idOrOptions === 'string') {
            if (backend.kind === 'remote') return backend.sdk.get<T>(idOrOptions, options);

            const res = await backend.client.get({ id: idOrOptions, ...options });
            return { data: res.data, version: res.version, versions: res.versions } as GetContextResponse<T>;
        }

        // LIST overload — no id (or a filters object) lists the project's contexts
        if (backend.kind === 'remote') return backend.sdk.get(idOrOptions);

        const res = await backend.client.list(idOrOptions ?? {});
        return { data: res.data };
    }

    // -- update ---------------------------------------------------------------

    // patch one message or an ARRAY (copy-on-write → new version). metadata via opts.
    async update<T = unknown>(contextId: string, input: UpdateInput, options?: MutationOptions): Promise<UpdateResponse<T>> {
        const backend = await this.resolve();
        if (backend.kind === 'remote') return backend.sdk.update<T>(contextId, input, options);

        // adapt to the object-arg client: array stays an array, object → [object]
        const updates = Array.isArray(input) ? input : [input];
        const res = await backend.client.update({ id: contextId, updates, metadata: options?.metadata });
        return { data: res.data, version: res.version } as UpdateResponse<T>;
    }

    // -- delete (overloaded: soft | permanent) --------------------------------

    // delete(id, ids[, opts]) → SOFT, versioned message delete → {data, version}
    async delete<T = unknown>(contextId: string, ids: DeleteInput, options?: MutationOptions): Promise<DeleteResponse<T>>;
    // delete(id, {permanent:true}) → HARD, whole-context delete → {deleted, id}
    async delete(contextId: string, input: DeletePermanentInput): Promise<PermanentDeleteResponse>;
    async delete<T = unknown>(
        contextId: string,
        input: DeleteInput | DeletePermanentInput,
        options?: MutationOptions,
    ): Promise<DeleteResponse<T> | PermanentDeleteResponse> {
        // permanent when input is a non-array object carrying permanent === true
        const isPermanent =
            typeof input === 'object' &&
            !Array.isArray(input) &&
            input !== null &&
            (input as DeletePermanentInput).permanent === true;

        // an EMPTY ids array is soft-delete intent with nothing to delete — refuse
        // it loudly (both modes) so it can never drift toward a permanent wipe.
        if (!isPermanent && Array.isArray(input) && input.length === 0) {
            throw new Error('delete needs message ids — pass at least one id/index, or { permanent: true } to delete the whole context');
        }

        const backend = await this.resolve();

        if (backend.kind === 'remote') {
            // delegate straight through — the SDK owns both DELETE shapes
            return isPermanent
                ? backend.sdk.delete(contextId, input as DeletePermanentInput)
                : backend.sdk.delete<T>(contextId, input as DeleteInput, options);
        }

        // local permanent → whole-context delete → {deleted, id, metadata?}
        if (isPermanent) {
            const meta = (input as DeletePermanentInput).metadata;
            const res = await backend.client.delete({ id: contextId, permanent: true, metadata: meta });
            return { deleted: res.deleted, id: res.id, ...(res.metadata ? { metadata: res.metadata } : {}) };
        }

        // local soft → message delete. core deleteMessages always returns
        // {data, version} on success (and throws otherwise), so the survivors +
        // new version are present unconditionally — no fallback needed.
        const ids = Array.isArray(input) ? input : [input as string | number];
        const res = await backend.client.delete({ id: contextId, ids, metadata: options?.metadata });
        return { data: res.data, version: res.version } as DeleteResponse<T>;
    }

    // -- deleteMany -----------------------------------------------------------

    // batch-delete whole contexts. Remote hits the batch endpoint; local loops
    // permanent deletes, capturing per-id errors into the row (never aborting).
    async deleteMany(ids: string[], options?: MutationOptions): Promise<DeleteManyResponse> {
        const backend = await this.resolve();
        if (backend.kind === 'remote') return backend.sdk.deleteMany(ids, options);

        // local fan-out — one permanent delete per id, errors captured not thrown
        const results: DeleteManyResult[] = [];
        for (const id of ids) {
            try {
                await backend.client.delete({ id, permanent: true, metadata: options?.metadata });
                results.push({ id, deleted: true });
            } catch (error) {
                results.push({ id, deleted: false, error: error instanceof Error ? error.message : String(error) });
            }
        }

        // a deleted_count summary alongside the per-id rows
        const deleted_count = results.filter((r) => r.deleted).length;
        return { results, deleted_count };
    }
}
