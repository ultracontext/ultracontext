// =============================================================================
// handlers — the serve route handlers. Each is a pure async fn over the request
// context (storage + the authed projectId + params/query/body) returning a
// { status, body } pair. They mirror the @ultracontext/js wire contract and the
// apps/api response shapes EXACTLY (status codes + envelopes) so the same SDK
// drives both — but here over the LOCAL sqlite via @ultracontext/core. apps/api
// is NOT imported; the shapes are reproduced, not borrowed.
// =============================================================================

import {
    createContext,
    listContexts,
    getContext,
    appendMessages,
    updateMessages,
    deleteContextPermanent,
    deleteMessages,
    deleteManyContexts,
    commitEvent,
    tailEvents,
    isPlainObject,
    resultStatus,
    type StorageAdapter,
    type EventStore,
    type ContextFilters,
    type Result,
} from '@ultracontext/core';

// -- request context -----------------------------------------------------------

// what every handler reads: the storage face + the EventStore face (the sqlite
// adapter is both), the authed project, the bound path params, parsed query, and
// the already-parsed JSON body (undefined when there was none).
export type ReqCtx = {
    storage: StorageAdapter;
    events: EventStore;
    projectId: number;
    params: Record<string, string>;
    query: URLSearchParams;
    body: unknown;
};

// the handler outcome — an HTTP status + a JSON-serializable body
export type Reply = { status: number; body: unknown };

// -- result → reply ------------------------------------------------------------

// map a failed core Result to its { error } reply at the right status; the ok
// payload is shaped by the caller (status differs per route: 200 vs 201).
function errReply(result: Extract<Result<unknown>, { ok: false }>): Reply {
    return { status: resultStatus(result.code), body: { error: result.message } };
}

// -- context handlers ----------------------------------------------------------

// POST /contexts → createContext. 201 on success (mirrors apps/api).
export async function createHandler(ctx: ReqCtx): Promise<Reply> {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const result = await createContext(ctx.storage, ctx.projectId, body);
    return result.ok ? { status: 201, body: result.data } : errReply(result);
}

// GET /contexts → listContexts. Reads the same filters the SDK serializes into
// the query string (limit default 20; after/before validated as timestamps).
export async function listHandler(ctx: ReqCtx): Promise<Reply> {
    const limit = parseInt(ctx.query.get('limit') ?? '20');
    const filters: ContextFilters & { limit?: number } = { limit };

    // metadata filters pass straight through to the adapter
    const source = ctx.query.get('source');
    const userId = ctx.query.get('user_id');
    const host = ctx.query.get('host');
    const projectPath = ctx.query.get('project_path');
    const sessionId = ctx.query.get('session_id');
    if (source) filters.source = source;
    if (userId) filters.user_id = userId;
    if (host) filters.host = host;
    if (projectPath) filters.project_path = projectPath;
    if (sessionId) filters.session_id = sessionId;

    // timestamp bounds are validated (a bad value is a 400, not a silent drop)
    const after = ctx.query.get('after');
    const before = ctx.query.get('before');
    if (after) {
        if (isNaN(Date.parse(after))) return { status: 400, body: { error: 'Invalid after timestamp' } };
        filters.after = after;
    }
    if (before) {
        if (isNaN(Date.parse(before))) return { status: 400, body: { error: 'Invalid before timestamp' } };
        filters.before = before;
    }

    // listContexts returns the data envelope directly (not a Result)
    const data = await listContexts(ctx.storage, ctx.projectId, filters);
    return { status: 200, body: data };
}

// GET /contexts/:id → getContext. version/at/before/history come off the query
// (core coerces the string version/at; history is the literal 'true').
export async function getHandler(ctx: ReqCtx): Promise<Reply> {
    const opts = {
        version: ctx.query.get('version') ?? undefined,
        at: ctx.query.get('at') ?? undefined,
        before: ctx.query.get('before') ?? undefined,
        history: ctx.query.get('history') === 'true',
    };

    const result = await getContext(ctx.storage, ctx.projectId, ctx.params.id, opts);
    return result.ok ? { status: 200, body: result.data } : errReply(result);
}

// POST /contexts/:id → appendMessages. The SDK sends the message (or array)
// as the raw body; core normalizes a single object to an array. 201 on success.
export async function appendHandler(ctx: ReqCtx): Promise<Reply> {
    const result = await appendMessages(ctx.storage, ctx.projectId, ctx.params.id, ctx.body as object);
    return result.ok ? { status: 201, body: result.data } : errReply(result);
}

// PATCH /contexts/:id → updateMessages. core parses the body shape (array, single
// object, or { updates, metadata }); a bad body surfaces invalid_input → 400.
export async function updateHandler(ctx: ReqCtx): Promise<Reply> {
    if (ctx.body === undefined) return { status: 400, body: { error: 'Invalid JSON body' } };

    const result = await updateMessages(ctx.storage, ctx.projectId, ctx.params.id, ctx.body as object);
    return result.ok ? { status: 200, body: result.data } : errReply(result);
}

// DELETE /contexts/:id → disambiguate from the body shape, EXACTLY as apps/api:
// no body / {} / {permanent:true} → permanent whole-context delete; { ids } →
// soft, versioned message delete. {permanent} + {ids} together is rejected.
export async function deleteHandler(ctx: ReqCtx): Promise<Reply> {
    const body = ctx.body;
    const hasJsonBody = body !== undefined;

    // recognize the three body shapes the disambiguation hinges on
    const isEmptyBody = isPlainObject(body) && Object.keys(body).length === 0;
    const isExplicitPermanent = isPlainObject(body) && body.permanent === true;
    const hasIds = isPlainObject(body) && body.ids !== undefined;

    // both at once is ambiguous — force the caller to pick one
    if (isExplicitPermanent && hasIds) {
        return { status: 400, body: { error: 'Cannot combine "permanent" and "ids" in the same request — pick one' } };
    }

    // permanent path: no body / {} / {permanent:true}; optional audit metadata
    if (!hasJsonBody || isEmptyBody || isExplicitPermanent) {
        const auditMetadata = isPlainObject(body) && isPlainObject(body.metadata) ? body.metadata : undefined;
        const result = await deleteContextPermanent(ctx.storage, ctx.projectId, ctx.params.id, { auditMetadata });
        return result.ok ? { status: 200, body: result.data } : errReply(result);
    }

    // anything else must be a JSON object carrying ids for the message-delete path
    if (!isPlainObject(body)) return { status: 400, body: { error: 'Request body must be a JSON object' } };
    if (!hasIds) {
        return { status: 400, body: { error: 'Body must contain "ids" (delete messages) or {"permanent": true} (delete entire context)' } };
    }

    // message delete — ids + optional version metadata (core validates the shapes)
    const result = await deleteMessages(ctx.storage, ctx.projectId, ctx.params.id, {
        ids: body.ids as (string | number)[],
        userMetadata: body.metadata as Record<string, unknown> | undefined,
    });
    return result.ok ? { status: 200, body: result.data } : errReply(result);
}

// POST /contexts/delete-many → deleteManyContexts. Status mirrors apps/api:
// 200 (all ok), 207 (partial), 500 (all failed); a bad body is 400.
export async function deleteManyHandler(ctx: ReqCtx): Promise<Reply> {
    if (!isPlainObject(ctx.body)) return { status: 400, body: { error: 'Request body must be a JSON object' } };

    const result = await deleteManyContexts(ctx.storage, ctx.projectId, ctx.body.ids as string[]);
    if (!result.ok) return errReply(result);

    // 207 on partial, 500 when every item failed, 200 when all succeeded
    const { deleted_count, results } = result.data;
    const status = deleted_count === 0 ? 500 : deleted_count === results.length ? 200 : 207;
    return { status, body: result.data };
}

// -- event handlers ------------------------------------------------------------

// POST /events → commitEvent. The body IS the envelope; commit re-validates,
// stamps received_at, inserts committed (a dupe event_id → committed:false).
// A malformed envelope → invalid_input → 400. 200 carries { committed,
// received_at, event_id } — the same shape `uc event commit` produces.
export async function commitEventHandler(ctx: ReqCtx): Promise<Reply> {
    // commitEvent parses the JSON itself — re-stringify the already-parsed body
    const envelopeJson = JSON.stringify(ctx.body ?? null);
    const result = await commitEvent(ctx.events, envelopeJson);
    return result.ok ? { status: 200, body: result.data } : errReply(result);
}

// GET /events → tailEvents. Returns a JSON ARRAY of committed envelopes in
// chronological order, filtered by ?limit/kind/source/subject — the shape an
// HTTP event-tail consumer reads (the ssh path uses line-JSON; this is the array).
export async function tailEventHandler(ctx: ReqCtx): Promise<Reply> {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw ? parseInt(limitRaw) : undefined;

    // only the documented filters flow through
    const filters = {
        kind: ctx.query.get('kind') ?? undefined,
        source: ctx.query.get('source') ?? undefined,
        subject: ctx.query.get('subject') ?? undefined,
    };

    const result = await tailEvents(ctx.events, { limit, filters });
    return result.ok ? { status: 200, body: result.data } : errReply(result);
}
