import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { createContext } from './create-context';
import { listContexts } from './list-contexts';
import { getContext } from './get-context';

// -- pg-style storage ---------------------------------------------------------
// Wraps MemoryStorage so every read-path created_at comes back in Postgres'
// timestamptz shape ('YYYY-MM-DD HH:mm:ss.ffffff+00') instead of ISO — exactly
// what the postgres.js driver hands the API. Lets us prove the ops normalize.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function toPg(iso: string): string {
    return iso.replace('T', ' ').replace(/\.(\d{3})Z$/, '.$1000+00');
}

class PgStyleStorage extends MemoryStorage {
    async findContextBranches(contextId: string) {
        const rows = await super.findContextBranches(contextId);
        return rows.map((r) => ({ ...r, created_at: toPg(r.created_at) }));
    }

    async findVersions(contextId: string) {
        const rows = await super.findVersions(contextId);
        return rows.map((r) => ({ ...r, created_at: toPg(r.created_at) }));
    }

    async listRootContexts(projectId: number, limit: number, filters?: any) {
        const rows = await super.listRootContexts(projectId, limit, filters);
        return rows.map((r) => ({ ...r, created_at: toPg(r.created_at) }));
    }

    async insertNodes(values: any) {
        const rows = await super.insertNodes(values);
        return rows.map((r) => (r.created_at ? { ...r, created_at: toPg(r.created_at) } : r));
    }
}

describe('ops normalize Postgres-style timestamps to ISO', () => {
    // createContext.created_at
    it('createContext returns an ISO created_at', async () => {
        const storage = new PgStyleStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { metadata: {} });

        assert.ok(result.ok);
        assert.match((result as any).data.created_at, ISO);
    });

    // listContexts.data[].created_at
    it('listContexts returns ISO created_at for every row', async () => {
        const storage = new PgStyleStorage();
        const project = await storage.insertProject('test');
        await seedContext(storage, project!.id, { metadata: { source: 'cli' } });
        await seedContext(storage, project!.id, { metadata: { source: 'web' } });

        const result = await listContexts(storage, project!.id, {});

        assert.equal(result.data.length, 2);
        assert.ok(result.data.every((c) => ISO.test(c.created_at)));
    });

    // getContext.versions[].created_at
    it('getContext history returns ISO created_at for every version', async () => {
        const storage = new PgStyleStorage();
        const project = await storage.insertProject('test');
        const seeded = await seedContext(storage, project!.id, { messages: [{ role: 'user', content: 'hi' }] });

        const result = await getContext(storage, project!.id, seeded.rootId, { history: true });

        assert.ok(result.ok);
        const versions = (result as any).data.versions;
        assert.ok(versions.length > 0);
        assert.ok(versions.every((v: any) => ISO.test(v.created_at)));
    });
});
