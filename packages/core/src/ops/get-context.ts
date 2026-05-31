// =============================================================================
// GET CONTEXT — read a context's messages with version-control semantics
// (ported from GET /contexts/:id)
// =============================================================================

import { findHead, getOrderedNodes, getVersions } from '../context-chain';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- types --------------------------------------------------------------------

// selection + shaping options (mirror the route's query params)
export type GetContextOptions = {
    version?: number | string;
    at?: number | string;
    before?: string;
    history?: boolean;
};

// optional history entries when history is requested
type VersionEntry = {
    version: number;
    created_at: string;
    operation: 'create' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

type GetContextResult = { data: MessageView[]; version: number; versions?: VersionEntry[] };

// -- op -----------------------------------------------------------------------

export async function getContext(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    opts: GetContextOptions
): Promise<Result<GetContextResult>> {
    // history flag toggles inclusion of versions[]
    const includeHistory = opts.history === true;

    // parse + validate the before timestamp up front
    let beforeTs: number | undefined;
    if (opts.before !== undefined) {
        beforeTs = Date.parse(opts.before);
        if (isNaN(beforeTs)) return err('invalid_input', 'Invalid timestamp format');
    }

    // root must exist within this project
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    // collect all version heads under the root
    const versions = await getVersions(storage, root.public_id);
    let head: { public_id: string } | null;
    let currentVersion: number;

    // select the head: explicit version → before timestamp → latest
    if (opts.version !== undefined) {
        const versionNum = parseInt(String(opts.version));
        if (isNaN(versionNum) || versionNum < 0 || versionNum >= versions.length) {
            return err('not_found', 'Version not found');
        }
        head = { public_id: versions[versionNum].head_id };
        currentVersion = versionNum;
    } else if (beforeTs !== undefined) {
        const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs!).pop();
        if (!targetVersion) return err('not_found', 'No version found before timestamp');
        head = { public_id: targetVersion.head_id };
        currentVersion = targetVersion.version;
    } else {
        head = await findHead(storage, root.public_id);
        currentVersion = versions.length - 1;
    }

    // no head → empty context at version 0
    if (!head) return ok({ data: [], version: 0 });

    // ordered messages under the head, optionally filtered by the before cutoff
    let orderedNodes = await getOrderedNodes(storage, head.public_id);
    if (beforeTs !== undefined) {
        orderedNodes = orderedNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs!);
    }

    // build the optional history payload
    const versionsResponse = includeHistory
        ? versions.map(({ version, created_at, operation, affected, metadata }) => ({
              version,
              created_at,
              operation,
              affected,
              metadata,
          }))
        : undefined;

    // at slices messages up to and including the index, re-indexed from 0
    if (opts.at !== undefined) {
        const idx = parseInt(String(opts.at));
        if (isNaN(idx) || idx < 0) return err('invalid_input', 'Invalid index');
        if (idx >= orderedNodes.length) return err('not_found', 'Index out of range');

        const sliced = orderedNodes.slice(0, idx + 1).map((n: any, i: number) => ({
            ...n.content,
            id: n.public_id,
            index: i,
            metadata: n.metadata,
        }));
        return ok({ data: sliced, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
    }

    // default: all ordered messages
    const result = orderedNodes.map((n: any, index: number) => ({
        ...n.content,
        id: n.public_id,
        index,
        metadata: n.metadata,
    }));

    return ok({ data: result, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
}
