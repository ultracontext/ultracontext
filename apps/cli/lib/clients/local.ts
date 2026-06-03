// =============================================================================
// LocalContextClient — the ContextClient backed by local SQLite + core ops.
// No server: it opens a libsql adapter and calls @ultracontext/core directly.
// Every targeted verb takes an EXPLICIT context id — there is no default
// context. The single 'local' project is ensured once via ensureProject.
// =============================================================================

import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { StorageAdapter, Result } from '@ultracontext/core';
import {
    createContext,
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
    CreateInput, CreateResult,
    AppendInput, AppendResult,
    GetInput, GetResult,
    UpdateInput, UpdateResult,
    DeleteInput, DeleteResult,
    ListInput, ListResult,
    MessageView, VersionEntry,
} from '../context-client';
import { ensureProject } from '../context-resolver';

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
    ) {}

    // create a root context, or FORK from input.from (optionally at a past
    // version/index/timestamp). input.metadata tags the CONTEXT.
    async create(input: CreateInput): Promise<CreateResult> {
        return unwrap(await createContext(this.storage, this.projectId, {
            from: input.from,
            version: input.version,
            at: input.at,
            before: input.before,
            metadata: input.metadata,
        }));
    }

    // append messages to an explicit context, returning views + version + id
    async append(input: AppendInput): Promise<AppendResult> {
        const result = unwrap(await appendMessages(this.storage, this.projectId, input.id, input.messages));
        return { ...result, id: input.id };
    }

    // read an explicit context at the selected version/index (+ history)
    async get(input: GetInput): Promise<GetResult> {
        const data = unwrap(await getContext(this.storage, this.projectId, input.id, {
            version: input.version,
            at: input.at,
            before: input.before,
            history: input.history,
        }));
        return { data: data.data as MessageView[], version: data.version, versions: data.versions as VersionEntry[] | undefined };
    }

    // patch messages (copy-on-write → new version); input.metadata tags the version
    async update(input: UpdateInput): Promise<UpdateResult> {
        return unwrap(await updateMessages(this.storage, this.projectId, input.id, {
            updates: input.updates,
            metadata: input.metadata,
        }));
    }

    // delete specific messages (--ids) or, otherwise, the whole context.
    // input.metadata is plumbed through: version metadata for a message delete,
    // audit metadata for a permanent delete. The recorded metadata is echoed back
    // on the result so a delete's --meta is observable (not silently dropped).
    async delete(input: DeleteInput): Promise<DeleteResult> {
        // a sentinel so an absent --meta stays absent on the result
        const echo = input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined;

        // message-level delete — ids PRESENT selects this branch; an EMPTY list is
        // a caller bug, refused so it can never fall through to the wipe below.
        // core records --meta as version metadata (visible via get --history);
        // we also echo it on the result for symmetry with the permanent path.
        // core yields {data,version} (the survivors + new version) — surface it so
        // the unified SDK can mirror the remote soft-delete {data,version} shape.
        if (input.ids) {
            if (input.ids.length === 0) throw new Error('no message ids to delete — pass at least one id/index');
            const res = unwrap(await deleteMessages(this.storage, this.projectId, input.id, { ids: input.ids, userMetadata: input.metadata }));
            return { deleted: true, id: input.id, data: res.data as MessageView[], version: res.version, ...(echo ? { metadata: echo } : {}) };
        }

        // whole-context delete — requires an EXPLICIT permanent:true; anything
        // else is refused so malformed input can never silently wipe a context.
        if (input.permanent !== true) {
            throw new Error('nothing to delete — pass ids for a message delete, or permanent: true to delete the whole context');
        }

        // remove the context permanently. core echoes the audit metadata back;
        // surface it on the result so --meta is observable.
        const res = unwrap(await deleteContextPermanent(this.storage, this.projectId, input.id, { auditMetadata: input.metadata }));
        return { deleted: true, id: res.id, ...(res.metadata ? { metadata: res.metadata } : {}) };
    }

    // list the project's contexts (newest first). Forward the FULL filter set —
    // core listContexts passes ContextFilters straight to the adapter, which
    // applies all of them (source/user_id/host/project_path/session_id +
    // after/before), so none are silently dropped.
    async list(input: ListInput): Promise<ListResult> {
        return listContexts(this.storage, this.projectId, {
            limit: input.limit,
            source: input.source,
            user_id: input.user_id,
            host: input.host,
            project_path: input.project_path,
            session_id: input.session_id,
            after: input.after,
            before: input.before,
        });
    }
}

// -- factory ------------------------------------------------------------------

// ensure a `file:` db url's parent dir exists — on a fresh HOME ~/.ultracontext
// is absent, and libsql fails with SQLITE_CANTOPEN(14) opening into a missing
// dir. :memory: and remote (libsql://, http) urls have no local dir to create.
async function ensureDbDir(dbUrl: string): Promise<void> {
    if (!dbUrl.startsWith('file:')) return;
    await mkdir(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

// open the local adapter + ensure the project, then build the client.
// cwd is accepted for signature compatibility but no longer drives a default
// context — every verb targets an explicit id.
export async function createLocalClient(opts: { dbUrl: string; cwd?: string }): Promise<ContextClient> {
    await ensureDbDir(opts.dbUrl);
    const storage = await createSqliteAdapter(opts.dbUrl);
    const projectId = await ensureProject(storage);
    return new LocalContextClient(storage, projectId);
}
