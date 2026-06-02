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
    // audit metadata for a permanent delete.
    async delete(input: DeleteInput): Promise<DeleteResult> {
        // message-level delete — drop the targeted indices/ids, keep the context
        if (input.ids && input.ids.length > 0) {
            unwrap(await deleteMessages(this.storage, this.projectId, input.id, { ids: input.ids, userMetadata: input.metadata }));
            return { deleted: true, id: input.id };
        }

        // whole-context delete — remove the context permanently, recording the audit
        const res = unwrap(await deleteContextPermanent(this.storage, this.projectId, input.id, { auditMetadata: input.metadata }));
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
