// =============================================================================
// RemoteContextClient — the ContextClient backed by the hosted API. It owns no
// HTTP of its own: it delegates to the @ultracontext/js SDK (one client), just
// reshaping the ContextClient verbs onto the SDK's method surface. Every
// targeted verb takes an EXPLICIT context id — there is no default context.
// =============================================================================

import { UltraContext } from '@ultracontext/js';

import type {
    ContextClient,
    CreateInput, CreateResult,
    AppendInput, AppendResult,
    GetInput, GetResult,
    UpdateInput, UpdateResult,
    DeleteInput, DeleteResult,
    ListInput, ListResult,
    MessageView, VersionEntry,
} from '../context-client';

// -- client -------------------------------------------------------------------

class RemoteContextClient implements ContextClient {
    constructor(private sdk: UltraContext) {}

    // create a root context, or FORK from input.from. metadata tags the CONTEXT.
    async create(input: CreateInput): Promise<CreateResult> {
        return this.sdk.create({
            from: input.from,
            version: input.version,
            at: input.at,
            before: input.before,
            metadata: input.metadata,
        });
    }

    // append to an explicit context via the SDK
    async append(input: AppendInput): Promise<AppendResult> {
        const res = await this.sdk.append(input.id, input.messages);
        return { data: res.data as MessageView[], version: res.version, id: input.id };
    }

    // read an explicit context at the selected version/index (+ history)
    async get(input: GetInput): Promise<GetResult> {
        const res = await this.sdk.get(input.id, {
            version: input.version,
            at: input.at,
            before: input.before,
            history: input.history,
        });
        return { data: res.data as MessageView[], version: res.version, versions: res.versions as VersionEntry[] | undefined };
    }

    // patch messages (copy-on-write → new version); metadata tags the version
    async update(input: UpdateInput): Promise<UpdateResult> {
        const res = await this.sdk.update(
            input.id,
            input.updates as Parameters<UltraContext['update']>[1],
            input.metadata ? { metadata: input.metadata } : undefined,
        );
        return { data: res.data as MessageView[], version: res.version };
    }

    // delete specific messages (--ids), else the whole context (--permanent).
    // metadata is plumbed through: version metadata for a message delete, audit
    // metadata for a permanent delete.
    async delete(input: DeleteInput): Promise<DeleteResult> {
        // message-level delete — drop the targeted indices/ids, keep the context
        if (input.ids && input.ids.length > 0) {
            await this.sdk.delete(input.id, input.ids, input.metadata ? { metadata: input.metadata } : undefined);
            return { deleted: true, id: input.id };
        }

        // whole-context delete — permanent removal on the hosted side, with audit
        const res = await this.sdk.delete(input.id, input.metadata ? { permanent: true, metadata: input.metadata } : { permanent: true });
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
