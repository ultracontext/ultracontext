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
    DeleteManyInput, DeleteManyResult,
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
    // metadata for a permanent delete. Mirrors the local client's guards: an
    // empty ids list and an implicit permanent are refused, never executed.
    async delete(input: DeleteInput): Promise<DeleteResult> {
        // message-level delete — ids PRESENT selects this branch; an EMPTY list
        // is a caller bug, refused so it can never reach the permanent wipe.
        // The API answers {data, version} — surface it so the CLI soft-delete
        // envelope matches the local client's {deleted, id, data, version}.
        if (input.ids) {
            if (input.ids.length === 0) throw new Error('no message ids to delete — pass at least one id/index');
            const res = await this.sdk.delete(input.id, input.ids, input.metadata ? { metadata: input.metadata } : undefined);
            return { deleted: true, id: input.id, data: res.data as MessageView[], version: res.version };
        }

        // whole-context delete — requires an EXPLICIT permanent:true, so a
        // malformed input can never silently wipe a hosted context.
        if (input.permanent !== true) {
            throw new Error('nothing to delete — pass ids for a message delete, or permanent: true to delete the whole context');
        }

        // permanent removal on the hosted side, with audit metadata
        const res = await this.sdk.delete(input.id, input.metadata ? { permanent: true, metadata: input.metadata } : { permanent: true });
        return { deleted: true, id: res.id };
    }

    // batch-delete WHOLE contexts via the SDK's real batch endpoint — ONE HTTP
    // call (POST /contexts/delete-many), no client-side fan-out. The SDK's
    // {results, deleted_count} envelope (which already carries per-id errors for
    // 207/500 partials) is surfaced VERBATIM.
    async deleteMany(input: DeleteManyInput): Promise<DeleteManyResult> {
        return this.sdk.deleteMany(input.ids, input.metadata ? { metadata: input.metadata } : undefined);
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
