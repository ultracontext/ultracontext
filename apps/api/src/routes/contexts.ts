import type { StorageAdapter, NodeRow, ContextFilters } from '../storage/types';
import { buildNodeInsertRecords, findHead, findTail, getOrderedNodes, getVersions } from '../domain/context-chain';
import { generatePublicId } from '../domain/public-ids';
import type { HttpApp } from '../types/http';
import { firstRow } from '../utils/first-row';
import { isPlainObject, parseUpdateRequestBody } from '../utils/request-parsing';
import { MAX_BATCH_DELETE } from '../constants';

// -- rollback helpers ---------------------------------------------------------

async function rollbackHead(storage: StorageAdapter, projectId: number, headId: string) {
    try {
        await storage.deleteNodesByContextId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for children of head ${headId}: ${message}`);
    }

    try {
        await storage.deleteNodeByPublicId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for head ${headId}: ${message}`);
    }
}

async function rollbackRootContext(storage: StorageAdapter, projectId: number, rootId: string, headId: string) {
    await rollbackHead(storage, projectId, headId);

    try {
        await storage.deleteNodesByContextId(projectId, rootId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for branches of root ${rootId}: ${message}`);
    }

    try {
        await storage.deleteNodeByPublicId(projectId, rootId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for root ${rootId}: ${message}`);
    }
}

// -- permanent-delete helper --------------------------------------------------

async function permanentlyDelete(storage: StorageAdapter, projectId: number, rootPublicId: string) {
    const branches = await storage.findContextBranches(rootPublicId);

    // Per branch: batch-clear parent refs for its messages, then delete them
    for (const branch of branches) {
        const messages = await storage.findNonContextNodes(branch.public_id);
        const msgIds = messages.map((m) => m.public_id);
        await storage.clearParentReferencesBulk(projectId, msgIds);
        await storage.clearParentReferences(projectId, branch.public_id);
        await storage.deleteNodesByContextId(projectId, branch.public_id);
    }

    // Clear parent refs pointing to root (forked contexts)
    await storage.clearParentReferences(projectId, rootPublicId);

    // Delete version head nodes
    await storage.deleteNodesByContextId(projectId, rootPublicId);

    // Delete the root node itself
    await storage.deleteNodeByPublicId(projectId, rootPublicId);
}

// -- routes -------------------------------------------------------------------

export function registerContextRoutes(app: HttpApp) {
    app.post('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const body = await c.req.json().catch(() => ({}));
        const { from, version, at, before, metadata } = body;

        const storage = c.get('storage');

        let beforeTs: number | undefined;
        if (before !== undefined) {
            beforeTs = Date.parse(before);
            if (isNaN(beforeTs)) return c.json({ error: 'Invalid timestamp format' }, 400);
        }

        if ((version !== undefined || at !== undefined || before !== undefined) && !from) {
            return c.json({ error: 'version, at, and before require from' }, 400);
        }

        let sourceNodes: NodeRow[] = [];
        if (from) {
            const sourceCtx = await storage.findRootContextByPublicId(from);
            if (!sourceCtx) return c.json({ error: 'Source context not found' }, 404);

            let sourceHead;
            const versions = await getVersions(storage, from);

            if (version !== undefined) {
                const versionNum = parseInt(String(version));
                if (isNaN(versionNum) || versionNum < 0 || versionNum >= versions.length) {
                    return c.json({ error: 'Version not found' }, 404);
                }
                sourceHead = { public_id: versions[versionNum].head_id };
            } else if (beforeTs !== undefined) {
                const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs).pop();
                if (!targetVersion) return c.json({ error: 'No version found before timestamp' }, 404);
                sourceHead = { public_id: targetVersion.head_id };
            } else {
                sourceHead = await findHead(storage, from);
            }

            if (sourceHead) {
                sourceNodes = await getOrderedNodes(storage, sourceHead.public_id);

                if (beforeTs !== undefined) {
                    sourceNodes = sourceNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs);
                }

                if (at !== undefined) {
                    const idx = parseInt(String(at));
                    if (isNaN(idx) || idx < 0 || idx >= sourceNodes.length) {
                        return c.json({ error: 'Invalid index' }, 400);
                    }
                    sourceNodes = sourceNodes.slice(0, idx + 1);
                }
            }
        }

        // create root node
        const rootId = generatePublicId('context');
        const rootRows = await storage.insertNodes({
            public_id: rootId,
            project_id: projectId,
            type: 'context',
            context_id: null,
            parent_id: from ?? null,
            content: {},
            metadata: (metadata ?? {}) as Record<string, unknown>,
        });
        const root = firstRow(rootRows);
        if (!root) return c.json({ error: 'Failed to create context' }, 500);

        // create initial head
        const headId = generatePublicId('context');
        try {
            await storage.insertNodes({
                public_id: headId,
                project_id: projectId,
                type: 'context',
                context_id: rootId,
                prev_id: null,
                content: {},
                metadata: { operation: 'create' },
            });
        } catch {
            try {
                await storage.deleteNodeByPublicId(projectId, rootId);
            } catch (rollbackError) {
                const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                console.error(`Rollback failed for root ${rootId}: ${message}`);
            }
            return c.json({ error: 'Failed to create context' }, 500);
        }

        // copy source nodes if forking
        if (sourceNodes.length > 0) {
            const nodeInputs = sourceNodes.map((n) => ({
                type: 'message',
                content: n.content,
                metadata: n.metadata,
                parent_id: n.public_id,
            }));
            const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
            try {
                await storage.insertNodes(insertRecords);
            } catch {
                await rollbackRootContext(storage, projectId, rootId, headId);
                return c.json({ error: 'Failed to copy source context' }, 500);
            }
        }

        return c.json({ id: root.public_id, metadata: root.metadata, created_at: root.created_at }, 201);
    });

    app.get('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const limit = parseInt(c.req.query('limit') ?? '20');
        const storage = c.get('storage');

        // metadata + timestamp filters
        const filters: ContextFilters = {};
        const source = c.req.query('source');
        const userId = c.req.query('user_id');
        const host = c.req.query('host');
        const projectPath = c.req.query('project_path');
        const sessionId = c.req.query('session_id');
        const after = c.req.query('after');
        const before = c.req.query('before');
        if (source) filters.source = source;
        if (userId) filters.user_id = userId;
        if (host) filters.host = host;
        if (projectPath) filters.project_path = projectPath;
        if (sessionId) filters.session_id = sessionId;
        if (after) {
            if (isNaN(Date.parse(after))) return c.json({ error: 'Invalid after timestamp' }, 400);
            filters.after = after;
        }
        if (before) {
            if (isNaN(Date.parse(before))) return c.json({ error: 'Invalid before timestamp' }, 400);
            filters.before = before;
        }

        const data = await storage.listRootContexts(projectId, limit, filters);

        return c.json({
            data: data.map((n) => ({
                id: n.public_id,
                metadata: n.metadata,
                created_at: n.created_at,
            })),
        });
    });

    // -- delete-many contexts (must be registered before :id routes) -----------

    app.post('/contexts/delete-many', async (c) => {
        const { projectId } = c.get('auth');
        const body = await c.req.json().catch(() => null);

        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);

        const { ids } = body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return c.json({ error: 'ids must be a non-empty array of context IDs' }, 400);
        }
        if (ids.length > MAX_BATCH_DELETE) {
            return c.json({ error: `ids must contain at most ${MAX_BATCH_DELETE} items` }, 400);
        }
        // Validate element types upfront — fail the whole request on any non-string
        for (const el of ids) {
            if (typeof el !== 'string') return c.json({ error: 'Each id must be a string' }, 400);
        }

        const storage = c.get('storage');
        const results: Array<{ id: string; deleted: boolean; error?: string }> = [];

        for (const contextId of ids as string[]) {
            const root = await storage.findRootContext(projectId, contextId);
            if (!root) {
                results.push({ id: contextId, deleted: false, error: 'Not found' });
                continue;
            }

            try {
                await storage.transaction((tx) => permanentlyDelete(tx, projectId, root.public_id), { isolationLevel: 'serializable' });
                results.push({ id: contextId, deleted: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                results.push({ id: contextId, deleted: false, error: message });
            }
        }

        // 207 Multi-Status when partial failure; 500 if every item failed
        const deletedCount = results.filter((r) => r.deleted).length;
        const status = deletedCount === 0 ? 500 : deletedCount === results.length ? 200 : 207;
        return c.json({ results, deleted_count: deletedCount }, status);
    });

    // -- parameterized :id routes ------------------------------------------------

    app.post('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json();
        const storage = c.get('storage');

        // Serializable tx so concurrent permanent-delete can't race with append
        // (Postgres SSI makes one side fail with 40001; client retries).
        type AppendResult = { data: object[]; version: number } | { error: string; status: number };
        let outcome: AppendResult;
        try {
            outcome = await storage.transaction<AppendResult>(async (tx) => {
                const root = await tx.findRootContext(projectId, contextPublicId);
                if (!root) return { error: 'Context not found', status: 404 };

                const head = await findHead(tx, root.public_id);
                if (!head) return { error: 'HEAD not found', status: 500 };

                const messages = Array.isArray(body) ? body : [body];
                const existingNodes = await getOrderedNodes(tx, head.public_id);
                const existingCount = existingNodes.length;
                const tailPublicId = await findTail(tx, head.public_id);

                const nodeInputs = messages.map((msg) => {
                    const { metadata, ...content } = msg;
                    return { type: 'message', content, metadata: metadata ?? {} };
                });
                const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, head.public_id, tailPublicId);

                const createdNodes = await tx.insertNodes(insertRecords);

                const versions = await getVersions(tx, root.public_id);
                const currentVersion = versions.length - 1;

                const data = createdNodes.map((node, i: number) => ({
                    ...(node.content as object),
                    id: node.public_id,
                    index: existingCount + i,
                    metadata: node.metadata,
                }));

                return { data, version: currentVersion };
            }, { isolationLevel: 'serializable' });
        } catch {
            return c.json({ error: 'Failed to append messages' }, 500);
        }

        if ('error' in outcome) return c.json({ error: outcome.error }, outcome.status as 404 | 500);
        return c.json({ data: outcome.data, version: outcome.version }, 201);
    });

    app.get('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const contextPublicId = c.req.param('id');
        const includeHistory = c.req.query('history') === 'true';

        const before = c.req.query('before');
        let beforeTs: number | undefined;
        if (before !== undefined) {
            beforeTs = Date.parse(before);
            if (isNaN(beforeTs)) return c.json({ error: 'Invalid timestamp format' }, 400);
        }

        const storage = c.get('storage');

        const root = await storage.findRootContext(projectId, contextPublicId);
        if (!root) return c.json({ error: 'Context not found' }, 404);

        const versions = await getVersions(storage, root.public_id);
        const versionParam = c.req.query('version');
        let head;
        let currentVersion: number;

        if (versionParam !== undefined) {
            const versionNum = parseInt(versionParam);
            if (isNaN(versionNum) || versionNum < 0 || versionNum >= versions.length) {
                return c.json({ error: 'Version not found' }, 404);
            }
            head = { public_id: versions[versionNum].head_id };
            currentVersion = versionNum;
        } else if (beforeTs !== undefined) {
            const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs).pop();
            if (!targetVersion) return c.json({ error: 'No version found before timestamp' }, 404);
            head = { public_id: targetVersion.head_id };
            currentVersion = targetVersion.version;
        } else {
            head = await findHead(storage, root.public_id);
            currentVersion = versions.length - 1;
        }

        if (!head) return c.json({ data: [], version: 0 });

        let orderedNodes = await getOrderedNodes(storage, head.public_id);
        if (beforeTs !== undefined) {
            orderedNodes = orderedNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs);
        }

        const versionsResponse = includeHistory
            ? versions.map(({ version, created_at, operation, affected, metadata }) => ({
                  version,
                  created_at,
                  operation,
                  affected,
                  metadata,
              }))
            : undefined;

        const at = c.req.query('at');
        if (at !== undefined) {
            const idx = parseInt(at);
            if (isNaN(idx) || idx < 0) return c.json({ error: 'Invalid index' }, 400);
            if (idx >= orderedNodes.length) return c.json({ error: 'Index out of range' }, 404);

            const result = orderedNodes.slice(0, idx + 1).map((n: any, i: number) => ({
                ...n.content,
                id: n.public_id,
                index: i,
                metadata: n.metadata,
            }));
            return c.json({ data: result, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
        }

        const result = orderedNodes.map((n: any, index: number) => ({
            ...n.content,
            id: n.public_id,
            index,
            metadata: n.metadata,
        }));

        return c.json({ data: result, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
    });

    app.patch('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json().catch(() => null);

        if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);

        const storage = c.get('storage');
        const parsed = parseUpdateRequestBody(body);
        if ('error' in parsed) return c.json({ error: parsed.error }, 400);

        const { userMetadata, updates } = parsed;

        for (const u of updates) {
            if (!isPlainObject(u)) return c.json({ error: 'Each update must be an object' }, 400);
            const hasId = u.id !== undefined;
            const hasIndex = u.index !== undefined;
            if (hasId && hasIndex) return c.json({ error: 'Cannot specify both id and index' }, 400);
            if (!hasId && !hasIndex) return c.json({ error: 'Either id or index required' }, 400);
            if (hasId && typeof u.id !== 'string') return c.json({ error: 'id must be a string' }, 400);
            if (hasIndex && (typeof u.index !== 'number' || !Number.isInteger(u.index))) {
                return c.json({ error: 'index must be an integer' }, 400);
            }
        }

        const root = await storage.findRootContext(projectId, contextPublicId);
        if (!root) return c.json({ error: 'Context not found' }, 404);

        const currentHead = await findHead(storage, root.public_id);
        if (!currentHead) return c.json({ error: 'HEAD not found' }, 500);

        const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);
        const nodeIds = new Set(orderedNodes.map((n) => n.public_id));

        const resolvedUpdates: Array<{ id: string; [key: string]: unknown }> = [];
        for (const u of updates) {
            if (u.id) {
                if (!nodeIds.has(u.id)) return c.json({ error: `Message not found: ${u.id}` }, 404);
                const { index: _idx, ...rest } = u;
                resolvedUpdates.push(rest as { id: string; [key: string]: unknown });
            } else {
                let idx = u.index!;
                if (idx < 0) idx = orderedNodes.length + idx;
                if (idx < 0 || idx >= orderedNodes.length) return c.json({ error: `Index out of range: ${u.index}` }, 400);
                const { index: _idx, ...rest } = u;
                resolvedUpdates.push({ ...rest, id: orderedNodes[idx].public_id });
            }
        }

        const updateMap = new Map(resolvedUpdates.map((u) => [u.id, u]));
        const affectedIds = resolvedUpdates.map((u) => u.id);

        // create new version head
        const newHeadId = generatePublicId('context');
        try {
            await storage.insertNodes({
                public_id: newHeadId,
                project_id: projectId,
                type: 'context',
                context_id: root.public_id,
                prev_id: currentHead.public_id,
                content: {},
                metadata: { operation: 'update', affected: affectedIds, ...(userMetadata ?? {}) },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to create version head';
            return c.json({ error: message }, 500);
        }

        // build updated node copies
        const newNodes = orderedNodes.map((n) => {
            const update = updateMap.get(n.public_id);
            const { id: _id, ...changes } = update ?? { id: null };
            return {
                public_id: generatePublicId('msg'),
                project_id: projectId,
                type: 'message',
                context_id: newHeadId,
                parent_id: n.public_id,
                prev_id: null as string | null,
                content: update ? { ...n.content, ...changes } : n.content,
                metadata: n.metadata,
            };
        });

        for (let i = 1; i < newNodes.length; i++) {
            newNodes[i].prev_id = newNodes[i - 1].public_id;
        }

        try {
            await storage.insertNodes(newNodes);
        } catch {
            await rollbackHead(storage, projectId, newHeadId);
            return c.json({ error: 'Failed to update messages' }, 500);
        }

        const versions = await getVersions(storage, root.public_id);
        const currentVersion = versions.length - 1;
        const result = newNodes.map((n, index: number) => ({
            ...(n.content as object),
            id: n.public_id,
            index,
            metadata: n.metadata,
        }));

        return c.json({ data: result, version: currentVersion });
    });

    // -- delete context or messages -----------------------------------------------

    app.delete('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const contextPublicId = c.req.param('id');
        const storage = c.get('storage');

        // Check Content-Type to distinguish "no body" from "JSON body"
        const contentType = c.req.header('content-type') ?? '';
        const hasJsonBody = contentType.includes('application/json');

        let body: any = null;
        if (hasJsonBody) {
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400);
            }
        }

        // Permanent delete path: no body, OR explicit {permanent: true}. Any other body shape must opt
        // in explicitly to prevent typos (e.g. `{IDs:[...]}`, `{id:"x"}`) from silently wiping the context.
        const isEmptyBody = isPlainObject(body) && Object.keys(body).length === 0;
        const isExplicitPermanent = isPlainObject(body) && body.permanent === true;
        const hasIds = isPlainObject(body) && body.ids !== undefined;

        // Reject ambiguous bodies that combine both — forces the caller to pick one
        if (isExplicitPermanent && hasIds) {
            return c.json({ error: 'Cannot combine "permanent" and "ids" in the same request — pick one' }, 400);
        }

        if (!hasJsonBody || isEmptyBody || isExplicitPermanent) {
            // Optional audit metadata logged at infra level (permanent delete wipes history)
            const auditMetadata = isPlainObject(body) && isPlainObject(body.metadata) ? body.metadata : undefined;
            if (auditMetadata) {
                console.info(JSON.stringify({ op: 'permanent_delete', project_id: projectId, context_id: contextPublicId, metadata: auditMetadata }));
            }

            const root = await storage.findRootContext(projectId, contextPublicId);
            if (!root) return c.json({ error: 'Context not found' }, 404);

            try {
                await storage.transaction((tx) => permanentlyDelete(tx, projectId, root.public_id), { isolationLevel: 'serializable' });
                return c.json({ deleted: true, id: contextPublicId, ...(auditMetadata ? { metadata: auditMetadata } : {}) });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to delete context';
                return c.json({ error: message }, 500);
            }
        }

        // From here, body must have `ids` for message-delete path
        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);
        if (!hasIds) {
            return c.json({ error: 'Body must contain "ids" (delete messages) or {"permanent": true} (delete entire context)' }, 400);
        }

        const { ids, metadata: userMetadata } = body;
        if (ids === undefined || ids === null) return c.json({ error: 'ids is required' }, 400);
        if (userMetadata !== undefined && !isPlainObject(userMetadata)) {
            return c.json({ error: 'metadata must be an object' }, 400);
        }
        const rawIds: Array<string | number> = Array.isArray(ids) ? ids : [ids];
        if (rawIds.length === 0) return c.json({ error: 'ids must be a non-empty array' }, 400);

        for (const input of rawIds) {
            if (typeof input === 'string') continue;
            if (typeof input !== 'number' || !Number.isInteger(input)) {
                return c.json({ error: 'Each id must be a string or integer index' }, 400);
            }
        }

        const root = await storage.findRootContext(projectId, contextPublicId);
        if (!root) return c.json({ error: 'Context not found' }, 404);

        const currentHead = await findHead(storage, root.public_id);
        if (!currentHead) return c.json({ error: 'HEAD not found' }, 500);

        const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);
        const nodeIds = new Set(orderedNodes.map((n) => n.public_id));

        const idsToDelete: string[] = [];
        for (const input of rawIds) {
            if (typeof input === 'string') {
                if (!nodeIds.has(input)) return c.json({ error: `Message not found: ${input}` }, 404);
                idsToDelete.push(input);
            } else {
                let idx = input;
                if (idx < 0) idx = orderedNodes.length + idx;
                if (idx < 0 || idx >= orderedNodes.length) return c.json({ error: `Index out of range: ${input}` }, 400);
                idsToDelete.push(orderedNodes[idx].public_id);
            }
        }
        const deleteSet = new Set(idsToDelete);

        // create new version head
        const newHeadId = generatePublicId('context');
        try {
            await storage.insertNodes({
                public_id: newHeadId,
                project_id: projectId,
                type: 'context',
                context_id: root.public_id,
                prev_id: currentHead.public_id,
                content: {},
                metadata: { operation: 'delete', affected: idsToDelete, ...(userMetadata ?? {}) },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to create version head';
            return c.json({ error: message }, 500);
        }

        // build filtered node copies
        const filtered = orderedNodes.filter((n) => !deleteSet.has(n.public_id));
        const newNodes = filtered.map((n) => ({
            public_id: generatePublicId('msg'),
            project_id: projectId,
            type: 'message',
            context_id: newHeadId,
            parent_id: n.public_id,
            prev_id: null as string | null,
            content: n.content,
            metadata: n.metadata,
        }));

        for (let i = 1; i < newNodes.length; i++) {
            newNodes[i].prev_id = newNodes[i - 1].public_id;
        }

        if (newNodes.length > 0) {
            try {
                await storage.insertNodes(newNodes);
            } catch {
                await rollbackHead(storage, projectId, newHeadId);
                return c.json({ error: 'Failed to delete messages' }, 500);
            }
        }

        const versions = await getVersions(storage, root.public_id);
        const currentVersion = versions.length - 1;
        const result = newNodes.map((n, index: number) => ({
            ...(n.content as object),
            id: n.public_id,
            index,
            metadata: n.metadata,
        }));

        return c.json({ data: result, version: currentVersion });
    });
}
