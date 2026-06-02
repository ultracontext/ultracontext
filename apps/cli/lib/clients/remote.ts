// =============================================================================
// RemoteContextClient — the ContextClient backed by the hosted API. It owns no
// HTTP of its own: it delegates to the @ultracontext/js SDK (one client), just
// reshaping the ContextClient verbs onto the SDK's method surface.
// =============================================================================

import { UltraContext } from '@ultracontext/js';

import type {
    ContextClient,
    AddInput, AddResult,
    GetInput, GetResult,
    UpdateInput, UpdateResult,
    DeleteInput, DeleteResult,
    ListInput, ListResult,
    MessageView,
} from '../context-client';

// -- client -------------------------------------------------------------------

class RemoteContextClient implements ContextClient {
    constructor(private sdk: UltraContext) {}

    // append to an explicit context, or create one first when no id is given
    async add(input: AddInput): Promise<AddResult> {
        // no id → create a fresh context (carrying any root metadata), then append
        const id = input.id ?? (await this.sdk.create({ metadata: input.metadata })).id;

        // surface the resolved id so callers (and agents) can chain on it
        const res = await this.sdk.append(id, input.messages);
        return { data: res.data as MessageView[], version: res.version, id };
    }

    // read an explicit context at the selected version/index (no cwd default remotely)
    async get(input: GetInput): Promise<GetResult> {
        if (!input.id) throw new Error('a context id is required for remote get');

        const res = await this.sdk.get(input.id, {
            version: input.version,
            at: input.at,
            before: input.before,
            history: input.history,
        });
        return { data: res.data as MessageView[], version: res.version };
    }

    // patch messages (copy-on-write → new version) on an explicit context
    async update(input: UpdateInput): Promise<UpdateResult> {
        if (!input.id) throw new Error('a context id is required for remote update');

        const res = await this.sdk.update(
            input.id,
            input.updates as Parameters<UltraContext['update']>[1],
            input.metadata ? { metadata: input.metadata } : undefined,
        );
        return { data: res.data as MessageView[], version: res.version };
    }

    // delete specific messages (--ids), else the whole context (--permanent)
    async delete(input: DeleteInput): Promise<DeleteResult> {
        if (!input.id) throw new Error('a context id is required for remote delete');

        // message-level delete — drop the targeted indices/ids, keep the context
        if (input.ids && input.ids.length > 0) {
            await this.sdk.delete(input.id, input.ids);
            return { deleted: true, id: input.id };
        }

        // whole-context delete — permanent removal on the hosted side
        const res = await this.sdk.delete(input.id, { permanent: true });
        return { deleted: true, id: res.id };
    }

    // list the project's contexts (newest first), filtered — SDK's list overload
    async list(input: ListInput): Promise<ListResult> {
        const res = await this.sdk.get({
            limit: input.limit,
            source: input.source,
            project_path: input.project_path,
            session_id: input.session_id,
        });
        return { data: res.data };
    }
}

// -- factory ------------------------------------------------------------------

// wrap an existing SDK instance in the ContextClient interface
export function createRemoteClient(sdk: UltraContext): ContextClient {
    return new RemoteContextClient(sdk);
}

// build the remote client from credentials — constructs the SDK, then wraps it
export function createRemoteClientFromConfig(opts: { apiKey: string; baseUrl?: string }): ContextClient {
    const sdk = new UltraContext({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
    return createRemoteClient(sdk);
}
