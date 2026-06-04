// =============================================================================
// server — the self-hosted Context API over @ultracontext/core + the LOCAL
// sqlite. Built on node:http (works under node AND the bun --compile binary; no
// framework that would break `bun build --compile`). Wires: single-user bearer
// auth (the serve key) → the tiny router → the pure handlers → core ops. Data
// flows over real HTTP so the @ultracontext/js SDK drives it unchanged. apps/api
// is NOT imported — the contract is reproduced here for the single-user case.
// =============================================================================

import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

import { ensureServeKey, verifyBearer } from './auth';
import { matchRoute, type Route } from './router';
import {
    createHandler, listHandler, getHandler, appendHandler, updateHandler,
    deleteHandler, deleteManyHandler, commitEventHandler, tailEventHandler,
    type ReqCtx, type Reply,
} from './handlers';

// -- route table ----------------------------------------------------------------

// the @ultracontext/js wire contract + events. ORDER matters: the static
// /contexts/delete-many sits before the /contexts/:id param routes so it wins.
type Handler = (ctx: ReqCtx) => Promise<Reply>;
const ROUTES: Route<{ handler: Handler }>[] = [
    { method: 'POST', path: '/contexts', handler: createHandler },
    { method: 'GET', path: '/contexts', handler: listHandler },
    { method: 'POST', path: '/contexts/delete-many', handler: deleteManyHandler },
    { method: 'POST', path: '/contexts/:id', handler: appendHandler },
    { method: 'GET', path: '/contexts/:id', handler: getHandler },
    { method: 'PATCH', path: '/contexts/:id', handler: updateHandler },
    { method: 'DELETE', path: '/contexts/:id', handler: deleteHandler },
    { method: 'POST', path: '/events', handler: commitEventHandler },
    { method: 'GET', path: '/events', handler: tailEventHandler },
];

// -- bearer extraction ----------------------------------------------------------

// pull the `Bearer <token>` token off the Authorization header; null when absent
// or not a bearer scheme (the request then 401s).
function readBearer(req: IncomingMessage): string | null {
    const header = req.headers['authorization'];
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
    return token;
}

// -- body reader ----------------------------------------------------------------

// read the full request body, parsing JSON. undefined when there was no body;
// the { error } marker when the body was present but not valid JSON.
async function readJsonBody(req: IncomingMessage): Promise<{ value: unknown } | { error: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    // an empty body is "no body" — undefined (delete/route logic disambiguates)
    if (raw.length === 0) return { value: undefined };

    // a non-empty body must parse as JSON
    try {
        return { value: JSON.parse(raw) };
    } catch {
        return { error: 'Invalid JSON body' };
    }
}

// -- json response --------------------------------------------------------------

// write a JSON reply with the status + content-type the SDK expects
function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
}

// -- handle options -------------------------------------------------------------

// the runtime knobs the request handler reads: the opened adapter, the authed
// project the serve key unlocks, and whether auth is bypassed (--no-auth dev).
export type HandleOptions = {
    storage: Awaited<ReturnType<typeof createSqliteAdapter>>;
    projectId: number;
    noAuth: boolean;
};

// -- request handler ------------------------------------------------------------

// the single node:http listener: auth → route → parse body → handler → reply.
// Exported so a test can exercise it directly, but the server below uses it.
export function buildRequestHandler(opts: HandleOptions) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            // auth first (unless --no-auth) — a missing/bad bearer is 401, no body read
            if (!opts.noAuth) {
                const token = readBearer(req);
                const verified = token ? await verifyBearer(opts.storage, token) : null;
                if (!verified) {
                    res.setHeader('WWW-Authenticate', 'Bearer');
                    return sendJson(res, 401, { error: 'Unauthorized' });
                }
            }

            // route the method + url; an unmatched route is a 404
            const match = matchRoute(ROUTES, req.method ?? 'GET', req.url ?? '/');
            if (!match) return sendJson(res, 404, { error: 'Not found' });

            // read + parse the body (a malformed JSON body is a 400 before the handler)
            const parsed = await readJsonBody(req);
            if ('error' in parsed) return sendJson(res, 400, parsed);

            // the authed project scopes every op (the serve key's 'local' project)
            const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
            const ctx: ReqCtx = {
                storage: opts.storage,
                events: opts.storage,
                projectId: opts.projectId,
                params: match.params,
                query,
                body: parsed.value,
            };

            // dispatch to the matched handler and send its reply
            const reply = await match.route.handler(ctx);
            sendJson(res, reply.status, reply.body);
        } catch (error) {
            // any unhandled throw collapses to a single 500 (never leaks a stack)
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        }
    };
}

// -- db dir ---------------------------------------------------------------------

// ensure a `file:` db url's parent dir exists (libsql fails SQLITE_CANTOPEN(14)
// opening into a missing dir). :memory:/remote urls have no local dir to create.
async function ensureDbDir(dbUrl: string): Promise<void> {
    if (!dbUrl.startsWith('file:')) return;
    await mkdir(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

// -- start ----------------------------------------------------------------------

// options for starting the server: where to listen + the db + the auth toggle.
// port 0 binds an ephemeral port (tests + smoke). configDir is injectable so the
// serve-key prefix is remembered off the real ~/.ultracontext in tests.
export type ServeOptions = {
    port: number;
    host: string;
    dbUrl: string;
    noAuth?: boolean;
    configDir?: string;
};

// the running server handle: the live url, the bound port, the minted key (only
// on a fresh mint), whether auth is on, and a graceful close().
export type ServeHandle = {
    url: string;
    port: number;
    key?: string;
    noAuth: boolean;
    close: () => Promise<void>;
};

// open the local db, ensure the serve key, start listening. Resolves once the
// socket is bound (so the caller can print the url + key, and tests can connect).
export async function startServer(opts: ServeOptions): Promise<ServeHandle> {
    // open the SAME local db the CLI uses (UC_DB_URL / ~/.ultracontext/uc.db)
    await ensureDbDir(opts.dbUrl);
    const storage = await createSqliteAdapter(opts.dbUrl);

    // ensure the bearer key under the 'local' project (unless auth is disabled);
    // a fresh mint surfaces the raw key for the caller to print ONCE.
    const noAuth = opts.noAuth === true;
    const serveKey = noAuth
        ? { projectId: await ensureLocalProject(storage), minted: false as const, key: undefined }
        : await ensureServeKey(storage, opts.configDir);

    // wire the request handler over the opened adapter + the authed project
    const handler = buildRequestHandler({ storage, projectId: serveKey.projectId, noAuth });
    const server = createHttpServer((req, res) => { void handler(req, res); });

    // bind the socket (port 0 → ephemeral) and resolve once listening
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, resolve);
    });

    // the actual bound port (resolved even when port 0 was requested)
    const port = (server.address() as AddressInfo).port;
    const url = `http://${opts.host}:${port}`;

    // a graceful close that resolves once the socket is fully released
    const close = () => new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });

    return { url, port, key: serveKey.key, noAuth, close };
}

// -- local project (no-auth path) -----------------------------------------------

// resolve the 'local' project id without minting a key (the --no-auth path still
// scopes ops to the same project the CLI's verbs use).
async function ensureLocalProject(storage: Awaited<ReturnType<typeof createSqliteAdapter>>): Promise<number> {
    const { ensureProject } = await import('../context-resolver');
    return ensureProject(storage);
}
