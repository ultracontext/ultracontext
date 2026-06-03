/// <reference lib="dom" />

import type { StorageAdapter } from '@ultracontext/core';
import { SqliteAdapter } from '../sqlite/adapter';
import { schema, SCHEMA_SQL } from '../sqlite/schema';

// =============================================================================
// BROWSER SQLITE — sql.js (wasm) + IndexedDB snapshot persistence. Makes
// `new UltraContext()` work LOCALLY in a browser with no server and no key.
// Same SqliteAdapter (driver-agnostic) as the node/bun drivers; the only new
// pieces are: sql.js as the engine, and a debounced db.export() → IndexedDB
// save after mutations. NO node: imports — this module must stay browser-pure.
// OPFS / Worker are a future upgrade INSIDE this factory; v1 is snapshot-based.
// =============================================================================

// pinned to the installed sql.js version — keep in lockstep with package.json.
// browser apps with no `wasmUrl` fetch the wasm from this CDN; fully-offline
// apps pass an explicit `wasmUrl` so nothing is fetched at runtime.
const SQL_JS_VERSION = '1.14.1';
const DEFAULT_WASM_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/`;

// IndexedDB store coordinates — one object store keyed by the db `name`
const IDB_NAME = 'ultracontext';
const IDB_STORE = 'snapshots';

// debounce window for snapshot saves after a burst of mutations
const SAVE_DEBOUNCE_MS = 100;

// the adapter the factory returns: the full SqliteAdapter surface (StorageAdapter
// + helpers like findProjectByName) plus an explicit flush()
export type BrowserSqliteAdapter = SqliteAdapter & {
    // force-write the current db snapshot to IndexedDB now (await to be sure)
    flush(): Promise<void>;
};

// open options — `name` is the IndexedDB record key, `wasmUrl` overrides sql.js
// wasm location for bundlers (and enables fully-offline by self-hosting it).
export interface BrowserSqliteOptions {
    name?: string;
    wasmUrl?: string;
}

// -- factory ------------------------------------------------------------------

// open a browser SQLite adapter: init sql.js → restore prior snapshot (if any)
// → drizzle(sql-js) → apply DDL → wrap with debounced IndexedDB persistence.
export async function createBrowserSqliteAdapter(opts: BrowserSqliteOptions = {}): Promise<BrowserSqliteAdapter> {
    const name = opts.name ?? 'ultracontext.db';

    // init the sql.js engine — bare in node (self-locates wasm from node_modules),
    // or via locateFile when a url is known (explicit override, or CDN in browser)
    const initSqlJs = (await import('sql.js')).default;
    const wasmUrl = resolveWasmUrl(opts.wasmUrl);
    const SQL = wasmUrl ? await initSqlJs({ locateFile: () => wasmUrl }) : await initSqlJs();

    // feature-detect IndexedDB — absent (edge runtime / locked-down) → in-memory
    const idb = detectIndexedDb();

    // restore a prior snapshot for this name, else start from an empty database
    const bytes = idb ? await idbLoad(idb, name) : undefined;
    const db = new SQL.Database(bytes ?? undefined);

    // drizzle's sync sql-js wrapper → the exact BaseSQLiteDatabase SqliteAdapter wants
    const { drizzle } = await import('drizzle-orm/sql-js');
    const drizzleDb = drizzle(db, { schema });

    // apply the shared DDL once (CREATE TABLE IF NOT EXISTS … — safe on restore too)
    db.run(SCHEMA_SQL);

    // the driver-agnostic adapter, then a persistence wrapper around it
    const adapter = new SqliteAdapter(drizzleDb as never);
    return wrapWithPersistence(adapter, db, idb, name);
}

// -- wasm url resolution ------------------------------------------------------

// decide the sql.js wasm location: explicit override wins; otherwise only the
// browser needs a url (CDN default) — node self-locates so we return undefined.
function resolveWasmUrl(override?: string): string | undefined {
    if (override) return override;

    // a real browser (has `window`) with no override → pin to the CDN wasm file
    const isBrowser = typeof (globalThis as { window?: unknown }).window !== 'undefined';
    return isBrowser ? `${DEFAULT_WASM_BASE}sql-wasm.wasm` : undefined;
}

// -- persistence wrapper ------------------------------------------------------

// flag the methods that change data — a debounced snapshot save fires after any
// of these resolve. everything else (find*/list*) reads and never schedules.
const MUTATING_METHODS = new Set<keyof StorageAdapter>([
    'insertNodes',
    'deleteNodesByContextId',
    'deleteNodeByPublicId',
    'clearParentReferences',
    'clearParentReferencesBulk',
    'insertApiKey',
    'updateApiKeyLastUsedAt',
    'insertProject',
    'deleteProject',
    'transaction',
]);

// wrap the adapter so mutations schedule a debounced db.export() → IndexedDB
// save; reads pass straight through. adds flush() + a beforeunload best-effort.
function wrapWithPersistence(adapter: SqliteAdapter, db: SqlJsDatabase, idb: IDBDatabase | null, name: string): BrowserSqliteAdapter {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | undefined;

    // write the live snapshot to IndexedDB now (no-op when persistence is off)
    const save = async (): Promise<void> => {
        if (!idb) return;
        await idbSave(idb, name, db.export());
    };

    // coalesce a burst of mutations into one save ~100ms after the last one
    const scheduleSave = (): void => {
        if (!idb) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            pending = save();
        }, SAVE_DEBOUNCE_MS);
    };

    // force any pending snapshot out immediately and await it
    const flush = async (): Promise<void> => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        await pending;
        await save();
    };

    // best-effort synchronous-ish flush on tab close (browser only)
    if (typeof (globalThis as { window?: { addEventListener?: unknown } }).window !== 'undefined') {
        const win = (globalThis as unknown as { window: Window }).window;
        win.addEventListener('beforeunload', () => { void save(); });
    }

    // proxy the adapter: call through, schedule a save after mutating calls.
    // transaction's tx mutates the SAME db, so saving once it resolves is enough.
    const proxied = new Proxy(adapter, {
        get(target, prop, receiver) {
            if (prop === 'flush') return flush;
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;

            // bind so private `this.db` access inside the adapter keeps working
            const fn = value.bind(target);
            if (!MUTATING_METHODS.has(prop as keyof StorageAdapter)) return fn;

            // mutating call — await the result, then schedule a debounced save
            return async (...args: unknown[]) => {
                const result = await fn(...args);
                scheduleSave();
                return result;
            };
        },
    });

    return proxied as unknown as BrowserSqliteAdapter;
}

// -- indexeddb (browser-pure, promisified) ------------------------------------

// feature-detect IndexedDB; when absent, warn ONCE and run non-persistent
let warnedNoIdb = false;
function detectIndexedDb(): IDBDatabase | null {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (factory) return openIdbSync(factory);

    // edge runtime / locked-down browser — degrade to in-memory, warn once
    if (!warnedNoIdb) {
        warnedNoIdb = true;
        console.warn('[ultracontext] IndexedDB unavailable — running in-memory; context will not persist.');
    }
    return null;
}

// open (and version-upgrade) the database, returning a connection handle. the
// upgrade callback creates the object store; resolution is awaited at first use.
function openIdbSync(factory: IDBFactory): IDBDatabase {
    // a thin lazy handle: we actually open async on first load/save below. to
    // keep the factory signature simple we open eagerly and cache the promise.
    const handle = { db: null as IDBDatabase | null, promise: null as Promise<IDBDatabase> | null };

    // kick off the open immediately; load/save await the same promise
    handle.promise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            const conn = req.result;
            if (!conn.objectStoreNames.contains(IDB_STORE)) conn.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => { handle.db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
    });

    // return a proxy that resolves the real connection on demand
    return new Proxy({} as IDBDatabase, {
        get(_t, prop) {
            if (prop === '__handle') return handle;
            return Reflect.get(handle.db ?? {}, prop);
        },
    });
}

// resolve the underlying IDBDatabase connection from the lazy handle proxy
async function resolveConn(idb: IDBDatabase): Promise<IDBDatabase> {
    const handle = (idb as unknown as { __handle: { db: IDBDatabase | null; promise: Promise<IDBDatabase> } }).__handle;
    return handle.db ?? handle.promise;
}

// load the snapshot bytes stored under `name`, or undefined when none exist
async function idbLoad(idb: IDBDatabase, name: string): Promise<Uint8Array | undefined> {
    const conn = await resolveConn(idb);
    return new Promise<Uint8Array | undefined>((resolve, reject) => {
        const tx = conn.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(name);
        req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? undefined);
        req.onerror = () => reject(req.error);
    });
}

// persist the snapshot bytes under `name` (overwrites the prior snapshot)
async function idbSave(idb: IDBDatabase, name: string, bytes: Uint8Array): Promise<void> {
    const conn = await resolveConn(idb);
    return new Promise<void>((resolve, reject) => {
        const tx = conn.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(bytes, name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// -- local type alias ---------------------------------------------------------

// sql.js Database surface we use (export/run/new) — typed via @types/sql.js
type SqlJsDatabase = import('sql.js').Database;
