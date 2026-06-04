// =============================================================================
// serve — `uc serve [--port] [--host] [--db] [--no-auth]`. The self-hosted
// Context API + events over @ultracontext/core + the LOCAL sqlite (the same db
// the CLI's verbs use). Starts the node:http server, prints the listening url +
// the minted bearer key ONCE (stderr, the status stream — the user copies it
// into `uc remote set --key`), then blocks until the process is killed. The
// server start + the block are injected so a test asserts the wiring + output
// without binding a socket. Pipe-aware: url/keySet → stdout under --json, the
// human card + the raw key → stderr.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { emit, status, outputError, shouldJson } from '../../../lib/output';
import { dbUrl as defaultDbUrl } from '../../../lib/config';
import { startServer, type ServeHandle } from '../../../lib/serve/server';

// -- injectable runtime --------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// the seams the action drives: how to START the server + how to WAIT (block)
// after it's listening. The defaults start the real node:http server + block
// forever; tests inject a fake start + an immediate wait so nothing binds.
export type ServeDeps = {
    start: (opts: { port: number; host: string; dbUrl: string; noAuth?: boolean }) => Promise<ServeHandle>;
    wait: (handle: ServeHandle) => Promise<void>;
};

// runtime overrides — just io for tests
type Runtime = { io?: Io };

// -- options -------------------------------------------------------------------

// the flags that steer serve; the global --json flows in from the root
export type ServeOptions = { json?: boolean; port?: number; host?: string; db?: string; noAuth?: boolean };

// -- defaults ------------------------------------------------------------------

// localhost + 8787 by default (a non-routable bind unless --host opens it up)
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

// -- handler -------------------------------------------------------------------

// start the server, announce the url + the minted key (once), then block. Returns
// the process exit code (0 on a clean stop, 1 on a start failure).
export async function runServe(opts: ServeOptions, deps: ServeDeps, runtime: Runtime = {}): Promise<number> {
    const io = runtime.io;
    const json = shouldJson({ json: opts.json }, io);

    try {
        // resolve the listen target + db (defaults to the CLI's local db)
        const handle = await deps.start({
            port: opts.port ?? DEFAULT_PORT,
            host: opts.host ?? DEFAULT_HOST,
            dbUrl: opts.db ?? defaultDbUrl(),
            noAuth: opts.noAuth,
        });

        // announce — JSON envelope (url + keySet, NEVER the key) on stdout in
        // machine mode; a human card + the raw minted key on stderr otherwise.
        announce(handle, json, io);

        // block until the process is killed (the injected wait resolves in tests)
        await deps.wait(handle);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json });
    }
}

// -- announce ------------------------------------------------------------------

// emit the listening url + key. Machine mode: { url, keySet } on stdout (data),
// never the secret. Human mode: a status card + the raw key (first mint only) +
// the no-auth warning, all on stderr (the status stream — data stays clean).
function announce(handle: ServeHandle, json: boolean, io?: Io): void {
    // machine mode → one JSON line on stdout, key redacted to a boolean (the data
    // stream NEVER carries the secret). The raw key still reaches stderr below.
    if (json) {
        emit({ url: handle.url, port: handle.port, keySet: Boolean(handle.key), noAuth: handle.noAuth }, { json: true }, io);
    } else {
        // human mode → the listening card on stderr (decorative, TTY-gated status)
        status(`uc serve listening on ${handle.url}`, io);
    }

    // a fresh mint surfaces the raw key ONCE — load-bearing, so it goes straight to
    // stderr REGARDLESS of TTY/--json (status() is TTY-gated for decorative lines;
    // the key is not decorative and must always reach the user to copy).
    if (handle.key) keyNotice(handle, io);

    // --no-auth is a security downgrade — warn straight to stderr UNCONDITIONALLY
    // (never TTY-gated: it must survive a piped/non-TTY run, same as the key notice)
    if (handle.noAuth) (io?.stderr ?? process.stderr).write('WARNING: --no-auth — every request is unauthenticated (bind localhost only)\n');
}

// write the first-mint bearer key to stderr unconditionally (never stdout — it is
// a secret, kept off the data stream — but always shown so the user can copy it).
function keyNotice(handle: ServeHandle, io?: Io): void {
    const stderr = io?.stderr ?? process.stderr;
    stderr.write(`\nbearer key (copy into \`uc remote set <target> --api ${handle.url} --key …\`):\n`);
    stderr.write(`  ${handle.key}\n`);
}

// -- real deps -----------------------------------------------------------------

// the live start: the real node:http server over the local sqlite
const realStart: ServeDeps['start'] = (opts) => startServer(opts);

// the live wait: block until SIGINT/SIGTERM, then close gracefully. Resolves so
// runServe returns 0 (a clean stop). Never resolves on its own otherwise.
const realWait: ServeDeps['wait'] = (handle) =>
    new Promise<void>((resolve) => {
        const stop = async () => { await handle.close(); resolve(); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });

// -- command factory -----------------------------------------------------------

// build the `serve` verb, wiring the real server start + block behind the seam
export function buildServeCommand(): Command {
    const command = new Command('serve');

    // self-host the Context API + events over the local sqlite
    command
        .description('serve the Context API + events over your local storage')
        .option('--port <n>', 'port to listen on (default 8787)', (v) => parseInt(v, 10))
        .option('--host <addr>', 'host/address to bind (default 127.0.0.1)')
        .option('--db <url>', 'sqlite db url (default the CLI local db)')
        .option('--no-auth', 'disable bearer auth — localhost-only dev, every request is open')
        .action(async (opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);

            // wire the live deps behind the injectable seam
            const deps: ServeDeps = { start: realStart, wait: realWait };

            process.exitCode = await runServe(
                { json, port: opts.port, host: opts.host, db: opts.db, noAuth: opts.auth === false },
                deps,
            );
        });

    return command;
}
