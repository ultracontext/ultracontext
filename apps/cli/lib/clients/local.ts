// =============================================================================
// LocalContextClient — the ContextClient backed by local SQLite + core ops.
// No server: it opens a libsql adapter and calls @ultracontext/core directly,
// resolving the default context (per cwd) when a verb omits an explicit id.
// =============================================================================

import type { StorageAdapter, Result } from '@ultracontext/core';
import {
    appendMessages,
    getContext,
    updateMessages,
    deleteContextPermanent,
    deleteMessages,
    listContexts,
} from '@ultracontext/core';
import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

import type {
    ContextClient,
    AddInput, AddResult,
    GetInput, GetResult,
    UpdateInput, UpdateResult,
    DeleteInput, DeleteResult,
    ListInput, ListResult,
    MessageView,
} from '../context-client';
import { ensureProject, resolveDefaultContext } from '../context-resolver';

// -- result unwrap ------------------------------------------------------------

// unwrap a core Result, throwing its message on failure (commands map to exits)
function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(result.message);
    return result.data;
}

// -- client -------------------------------------------------------------------

class LocalContextClient implements ContextClient {
    constructor(
        private storage: StorageAdapter,
        private projectId: number,
        private cwd: string,
    ) {}

    // resolve the target context — explicit id, else the cwd's default
    private async targetId(id?: string, metadata?: Record<string, unknown>): Promise<string> {
        return id ?? resolveDefaultContext(this.storage, this.projectId, this.cwd, metadata);
    }

    // append messages, returning the created views + version
    async add(input: AddInput): Promise<AddResult> {
        // input.metadata tags a freshly-created default context (e.g. its source)
        const id = await this.targetId(input.id, input.metadata);
        return unwrap(await appendMessages(this.storage, this.projectId, id, input.messages));
    }

    // read the context's messages at the selected version/index
    async get(input: GetInput): Promise<GetResult> {
        const id = await this.targetId(input.id);
        const result = await getContext(this.storage, this.projectId, id, {
            version: input.version,
            at: input.at,
            before: input.before,
            history: input.history,
        });
        const data = unwrap(result);
        return { data: data.data as MessageView[], version: data.version };
    }

    // patch messages (copy-on-write → new version)
    async update(input: UpdateInput): Promise<UpdateResult> {
        const id = await this.targetId(input.id);
        return unwrap(await updateMessages(this.storage, this.projectId, id, {
            updates: input.updates,
            metadata: input.metadata,
        }));
    }

    // delete specific messages (--ids) or, otherwise, the whole context
    async delete(input: DeleteInput): Promise<DeleteResult> {
        const id = await this.targetId(input.id);

        // message-level delete — drop the targeted indices/ids, keep the context
        if (input.ids && input.ids.length > 0) {
            unwrap(await deleteMessages(this.storage, this.projectId, id, { ids: input.ids }));
            return { deleted: true, id };
        }

        // whole-context delete — remove the context permanently
        const res = unwrap(await deleteContextPermanent(this.storage, this.projectId, id, {}));
        return { deleted: true, id: res.id };
    }

    // list the project's contexts (newest first), filtered
    async list(input: ListInput): Promise<ListResult> {
        return listContexts(this.storage, this.projectId, {
            limit: input.limit,
            source: input.source,
            project_path: input.project_path,
            session_id: input.session_id,
        });
    }
}

// -- factory ------------------------------------------------------------------

// open the local adapter + ensure the project, then build the client
export async function createLocalClient(opts: { dbUrl: string; cwd: string }): Promise<ContextClient> {
    const storage = await createSqliteAdapter(opts.dbUrl);
    const projectId = await ensureProject(storage);
    return new LocalContextClient(storage, projectId, opts.cwd);
}
