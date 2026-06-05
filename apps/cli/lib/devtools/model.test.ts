// =============================================================================
// model.test — the panel's data layer over the PUBLIC UltraContext facade
// (browser backend: sql.js + fake-indexeddb, same harness as the facade tests).
// listContexts → newest-first rows {id, metadata, created_at}; inspectContext →
// {messages, version, versions}. Read-only — the model never mutates.
// =============================================================================

import 'fake-indexeddb/auto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UltraContext } from '../sdk/ultracontext';
import { loadLocalBackend } from '../sdk/local-backend.browser';
import type { Backend } from '../sdk/local-backend-types';

import { listContexts, inspectContext, clearAll, messageRole, messageText } from './model';

// -- browser-backed facade helper ----------------------------------------------

// a unique IndexedDB record name per call so tests never share state
let counter = 0;
function browserFacade(): UltraContext {
    const name = `uc-devtools-${process.pid}-${counter++}-${Date.now()}`;
    const uc = new UltraContext({ db: name });
    // bind the memoized backend to the browser seam (node test runtime)
    (uc as unknown as { backend: Promise<Backend> }).backend = loadLocalBackend({ db: name });
    return uc;
}

// a tiny sleep so created_at timestamps differ across creates
function tick(ms = 5): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// -- listContexts ---------------------------------------------------------------

describe('devtools model — listContexts', () => {
    // empty db → empty list, no throw
    it('returns [] on an empty database', async () => {
        const uc = browserFacade();
        assert.deepEqual(await listContexts(uc), []);
    });

    // rows carry id/metadata/created_at and come back NEWEST FIRST
    it('lists contexts newest-first with metadata', async () => {
        const uc = browserFacade();
        const first = await uc.create({ metadata: { app: 'older' } });
        await tick();
        const second = await uc.create({ metadata: { app: 'newer' } });

        const rows = await listContexts(uc);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].id, second.id);
        assert.equal(rows[0].metadata.app, 'newer');
        assert.equal(rows[1].id, first.id);
        assert.ok(rows[0].created_at >= rows[1].created_at);
    });
});

// -- inspectContext ---------------------------------------------------------------

describe('devtools model — inspectContext', () => {
    // messages + current version surface for the detail view
    it('returns messages and version for a context', async () => {
        const uc = browserFacade();
        const ctx = await uc.create();
        await uc.append(ctx.id, [{ content: 'hello' }, { content: 'world' }]);

        const detail = await inspectContext(uc, ctx.id);
        assert.equal(detail.messages.length, 2);
        assert.deepEqual((detail.messages[0] as { content: string }).content, 'hello');
        assert.ok(detail.version !== undefined);
    });

    // a fresh context inspects to zero messages (not a throw)
    it('returns an empty message list for a fresh context', async () => {
        const uc = browserFacade();
        const ctx = await uc.create();

        const detail = await inspectContext(uc, ctx.id);
        assert.deepEqual(detail.messages, []);
    });
});

// -- message display helpers --------------------------------------------------------

describe('devtools model — message helpers', () => {
    // role passes through when present, '?' otherwise
    it('extracts role with a fallback', () => {
        assert.equal(messageRole({ role: 'assistant' }), 'assistant');
        assert.equal(messageRole({ content: 'no role' }), '?');
        assert.equal(messageRole(null), '?');
        assert.equal(messageRole('not an object'), '?');
    });

    // string content wins; AI SDK text parts join as the fallback
    it('extracts text from content or parts', () => {
        assert.equal(messageText({ content: 'plain' }), 'plain');
        assert.equal(
            messageText({ parts: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] }),
            'a\nb',
        );
        assert.equal(messageText({ content: '', parts: [{ type: 'text', text: 'from parts' }] }), 'from parts');
        assert.equal(messageText({ content: 42 }), undefined);
        assert.equal(messageText(null), undefined);
    });
});

// -- clearAll ---------------------------------------------------------------------

describe('devtools model — clearAll', () => {
    // wipes every context permanently and reports the count
    it('deletes all contexts and returns the count', async () => {
        const uc = browserFacade();
        await uc.create();
        const ctx = await uc.create();
        await uc.append(ctx.id, { content: 'soon gone' });

        assert.equal(await clearAll(uc), 2);
        assert.deepEqual(await listContexts(uc), []);
    });

    // an empty db clears to zero without calling delete
    it('returns 0 on an empty database', async () => {
        const uc = browserFacade();
        assert.equal(await clearAll(uc), 0);
    });
});
