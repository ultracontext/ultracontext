import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { KEY_PREFIX_LEN } from '../constants';
import { createKey } from './create-key';

// -- input validation: name required ------------------------------------------
// Handler: `if (!name || typeof name !== 'string') return c.json({ error: 'name is required' }, 400)`.
// 400 maps to invalid_input; the message string must be preserved exactly.

describe('createKey — input validation', () => {
    it('rejects an undefined name', async () => {
        const storage = new MemoryStorage();

        // omit name entirely
        const result = await createKey(storage, undefined as unknown as string);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'name is required');
    });

    it('rejects an empty-string name', async () => {
        const storage = new MemoryStorage();

        // empty string is falsy
        const result = await createKey(storage, '');

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'name is required');
    });

    it('rejects a non-string name', async () => {
        const storage = new MemoryStorage();

        // a number is not a string
        const result = await createKey(storage, 123 as unknown as string);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'name is required');
    });

    it('does not create a project when name is invalid', async () => {
        const storage = new MemoryStorage();

        // track whether insertProject is reached
        let inserted = false;
        const original = storage.insertProject.bind(storage);
        storage.insertProject = async (name: string) => {
            inserted = true;
            return original(name);
        };

        await createKey(storage, '');

        assert.equal(inserted, false);
    });
});

// -- project creation failure -------------------------------------------------
// Handler: `if (!project) return c.json({ error: 'Failed to create project' }, 500)`.
// 500 maps to internal; the message string must be preserved exactly.

describe('createKey — project creation failure', () => {
    it('returns internal when insertProject yields null', async () => {
        const storage = new MemoryStorage();

        // force a null project
        storage.insertProject = async () => null;

        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, false);
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to create project');
    });

    it('does not attempt key creation when the project is null', async () => {
        const storage = new MemoryStorage();

        // null project, but flag any key insertion
        storage.insertProject = async () => null;
        let keyInserted = false;
        storage.insertApiKey = async () => {
            keyInserted = true;
        };

        await createKey(storage, 'my-project');

        assert.equal(keyInserted, false);
    });
});

// -- key creation failure + rollback ------------------------------------------
// Handler: on a thrown error during key generation/insert, it rolls the project
// back via deleteProject and returns `{ error: 'Failed to create key' }`, 500.
// 500 maps to internal; the message string must be preserved exactly.

describe('createKey — key creation failure', () => {
    it('returns internal when insertApiKey throws', async () => {
        const storage = new MemoryStorage();

        // make the key insert blow up
        storage.insertApiKey = async () => {
            throw new Error('db down');
        };

        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, false);
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to create key');
    });

    it('rolls back the created project when insertApiKey throws', async () => {
        const storage = new MemoryStorage();

        // capture the rolled-back project id
        let deletedId: number | null = null;
        storage.insertApiKey = async () => {
            throw new Error('db down');
        };
        storage.deleteProject = async (id: number) => {
            deletedId = id;
        };

        await createKey(storage, 'my-project');

        // the project that was just created (id 1) must be deleted
        assert.equal(deletedId, 1);
    });

    it('still returns internal when rollback itself throws', async () => {
        const storage = new MemoryStorage();

        // both key insert and rollback fail; the op must swallow the rollback error
        storage.insertApiKey = async () => {
            throw new Error('db down');
        };
        storage.deleteProject = async () => {
            throw new Error('rollback failed');
        };

        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, false);
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to create key');
    });
});

// -- success ------------------------------------------------------------------
// Handler: returns `{ key: raw, prefix, project_id: project.id }` where
// prefix = raw.slice(0, KEY_PREFIX_LEN) and the api key row is persisted.

describe('createKey — success', () => {
    it('returns key, prefix, and project_id on success', async () => {
        const storage = new MemoryStorage();

        // happy path
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        assert.ok(result.data);
        assert.equal(typeof result.data.key, 'string');
        assert.equal(typeof result.data.prefix, 'string');
        assert.equal(typeof result.data.project_id, 'number');
    });

    it('derives prefix from the first KEY_PREFIX_LEN chars of the key', async () => {
        const storage = new MemoryStorage();

        // prefix is exactly the leading slice of the raw key
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        assert.equal(result.data.prefix.length, KEY_PREFIX_LEN);
        assert.equal(result.data.prefix, result.data.key.slice(0, KEY_PREFIX_LEN));
    });

    it('returns a live-environment key from generateKey', async () => {
        const storage = new MemoryStorage();

        // generated keys carry the uc_ prefix from core's generateKey
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        assert.ok(result.data.key.startsWith('uc_'));
    });

    it('uses the id of the newly inserted project', async () => {
        const storage = new MemoryStorage();

        // first project gets id 1 from MemoryStorage
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        assert.equal(result.data.project_id, 1);
    });

    it('persists the api key so it is findable by prefix', async () => {
        const storage = new MemoryStorage();

        // round-trip the key through the prefix lookup
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        const stored = await storage.findApiKeyByPrefix(result.data.prefix);
        assert.ok(stored);
        assert.equal(stored.project_id, result.data.project_id);
    });

    it('stores the SHA-256 hash, never the raw key', async () => {
        const storage = new MemoryStorage();

        // the persisted hash must not equal the raw key
        const result = await createKey(storage, 'my-project');

        assert.equal(result.ok, true);
        const stored = await storage.findApiKeyByPrefix(result.data.prefix);
        assert.ok(stored);
        assert.notEqual(stored.key_hash, result.data.key);
        assert.equal(stored.key_hash.length, 64);
    });

    it('issues a distinct key+project for each call', async () => {
        const storage = new MemoryStorage();

        // two calls must not collide on key or project id
        const first = await createKey(storage, 'project-a');
        const second = await createKey(storage, 'project-b');

        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.notEqual(first.data.key, second.data.key);
        assert.notEqual(first.data.project_id, second.data.project_id);
    });
});
