import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { hashKey } from '../api-keys';
import { KEY_PREFIX_LEN } from '../constants';
import { verifyKey } from './verify-key';

// -- helper: seed a project + api key from a raw token ------------------------
// Mirrors how createApiKey stores credentials: prefix = first KEY_PREFIX_LEN
// chars of the token, key_hash = SHA-256 of the full token.

async function seedKey(storage: MemoryStorage, token: string) {
    const project = await storage.insertProject('test');

    await storage.insertApiKey({
        project_id: project!.id,
        key_prefix: token.slice(0, KEY_PREFIX_LEN),
        key_hash: await hashKey(token),
    });

    return project!.id;
}

// -- verifyKey — storage-fallback verification path ----------------------------

describe('verifyKey', () => {
    // success: stored key matches by prefix and hash → resolves to id pair
    it('resolves { apiKeyId, projectId } for a matching token', async () => {
        const storage = new MemoryStorage();

        const token = 'uc_test_abcdefghijklmnop';
        const projectId = await seedKey(storage, token);

        const result = await verifyKey(storage, token);

        assert.notEqual(result, null);
        assert.equal(result!.projectId, projectId);
        assert.equal(typeof result!.apiKeyId, 'number');
    });

    // no row: prefix is absent from storage → resolves null
    it('resolves null when no key matches the prefix', async () => {
        const storage = new MemoryStorage();

        const result = await verifyKey(storage, 'uc_test_doesnotexist');

        assert.equal(result, null);
    });

    // empty storage: nothing seeded at all → resolves null
    it('resolves null against an empty store', async () => {
        const storage = new MemoryStorage();

        const result = await verifyKey(storage, 'uc_test_anytokenvalue');

        assert.equal(result, null);
    });

    // hash mismatch: prefix collides but the full token differs → resolves null
    it('resolves null when the prefix matches but the hash differs', async () => {
        const storage = new MemoryStorage();

        // both tokens share the first KEY_PREFIX_LEN chars but diverge after
        const stored = 'uc_test_aaaaaaaaaaaa';
        const attempt = 'uc_test_aaaabbbbbbbb';
        assert.equal(stored.slice(0, KEY_PREFIX_LEN), attempt.slice(0, KEY_PREFIX_LEN));

        await seedKey(storage, stored);

        const result = await verifyKey(storage, attempt);

        assert.equal(result, null);
    });

    // prefix length: lookup keys off exactly the first KEY_PREFIX_LEN chars
    it('matches on the first KEY_PREFIX_LEN characters of the token', async () => {
        const storage = new MemoryStorage();

        const token = 'uc_test_prefixmatters_longtail_xyz';
        const projectId = await seedKey(storage, token);

        const result = await verifyKey(storage, token);

        assert.notEqual(result, null);
        assert.equal(result!.projectId, projectId);
    });

    // multiple keys: distinct prefixes resolve to their own project + id
    it('selects the correct key when several are stored', async () => {
        const storage = new MemoryStorage();

        const tokenA = 'uc_test_AAAAAAAAAAAAtail';
        const tokenB = 'uc_test_BBBBBBBBBBBBtail';
        const projectA = await seedKey(storage, tokenA);
        const projectB = await seedKey(storage, tokenB);

        const resultA = await verifyKey(storage, tokenA);
        const resultB = await verifyKey(storage, tokenB);

        assert.notEqual(resultA, null);
        assert.equal(resultA!.projectId, projectA);

        assert.notEqual(resultB, null);
        assert.equal(resultB!.projectId, projectB);

        // the two keys map to different api-key ids
        assert.notEqual(resultA!.apiKeyId, resultB!.apiKeyId);
    });

    // identity: returned apiKeyId is the stored row id, projectId is its project
    it('returns the stored row id and project id', async () => {
        const storage = new MemoryStorage();

        const token = 'uc_test_identitycheck0';
        const projectId = await seedKey(storage, token);

        // inspect the seeded row to assert against verifyKey's return
        const row = await storage.findApiKeyByPrefix(token.slice(0, KEY_PREFIX_LEN));
        assert.notEqual(row, null);

        const result = await verifyKey(storage, token);

        assert.notEqual(result, null);
        assert.equal(result!.apiKeyId, row!.id);
        assert.equal(result!.projectId, row!.project_id);
        assert.equal(result!.projectId, projectId);
    });
});
