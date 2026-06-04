// =============================================================================
// transport — resolve the event hub from the unified remote and build the
// pluggable Deliver + tail. The SELECTION (per primitive): an `api` coord present
// → HTTP (POST /events to deliver, GET /events to tail — works identically against
// `uc serve` and the hosted cloud, no ssh-per-event + no login-PATH fragility);
// ELSE a ssh remote → `ssh <host> 'bash -lc "uc event commit --from-stdin"'`
// piping the envelope JSON to stdin (the login shell loads the user PATH so the
// hub's `uc` resolves); ELSE a 'local' (or missing) config → localMode (emit IS
// the commit, in-db). The ssh runner is INJECTABLE (a stdin-capable spawn) and the
// HTTP transport takes an injectable fetch, so tests never hit real SSH/network.
// =============================================================================

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { loadConfig, isLocalConfig, defaultHostId, type CommandResult } from '@ultracontext/sync';

import type { Deliver } from '@ultracontext/core';

import { readRemote, type RemoteApi, type RemoteConfig } from '../remote';

// -- injectable runner --------------------------------------------------------

// runs a program with args, optionally piping a string to its stdin — the seam
// fakes inject so tests skip the SSH binary entirely.
export type StdinRunner = (program: string, args: string[], stdin?: string) => Promise<CommandResult>;

// the real runner: spawn the process, write stdin, collect its stdio + exit code
export const spawnStdinRunner: StdinRunner = (program, args, stdin) =>
    new Promise((resolve, reject) => {
        const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        // accumulate both output streams
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        // pipe the envelope to stdin and close it
        if (stdin !== undefined) child.stdin.write(stdin);
        child.stdin.end();

        // resolve on exit, reject only if the binary couldn't launch at all
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });

// -- resolved transport -------------------------------------------------------

// the resolved hub context the event ops + CLI read: emit mode, the status
// target + host id, a Deliver the flusher retries pending rows through, and an
// optional tail (the transport-native way to read the hub's committed log — ssh
// over the login shell, or HTTP GET /events; absent in local mode where the CLI
// reads its own db directly). Keeping tail ON the transport makes the CLI's
// tail action transport-agnostic — it never branches on ssh-vs-http itself.
export type Transport = {
    localMode: boolean;
    target: string;
    host: string;
    deliver: Deliver;
    tail?: (filters: RemoteTailFilters) => Promise<RemoteTailResult>;
};

// -- ssh hardening ------------------------------------------------------------

// flags every ssh hop leads with (matches the ios-relay guide's BatchMode hop).
// BatchMode=yes never prompts for a password — an unreachable / auth-failing hub
// fails fast instead of blocking on a TTY prompt. ConnectTimeout bounds the TCP
// connect so an unroutable host errors in seconds, not the OS's ~75s+ default.
export const SSH_HARDENING = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

// -- remote PATH via a login shell --------------------------------------------

// ssh runs a NON-LOGIN, non-interactive shell whose PATH excludes ~/.local/bin —
// where `uc` installs — so a bare `ssh <host> 'uc …'` fails `command not found`
// (exit 127). Wrapping the remote uc invocation in a LOGIN shell sources the
// user's profile (~/.profile etc.), restoring ~/.local/bin on PATH (BUG 2). The
// inner command is composed ONLY from a fixed string + already charset-validated
// tokens (no quotes/spaces/metachars), so double-quoting it is injection-safe.
export function loginShellWrap(command: string): string {
    return `bash -lc "${command}"`;
}

// -- remote tail --------------------------------------------------------------

// the documented `uc event tail` filters that flow through to the hub command.
export type RemoteTailFilters = { limit?: number; kind?: string; source?: string; subject?: string };

// the same token charset core enforces on kind/source/subject — anything outside
// it (quotes, spaces, shell metachars) is rejected, so a filter value can never
// break out of the fixed remote `uc event tail` invocation (shell-injection guard).
const TOKEN_CHARSET = /^[A-Za-z0-9_\-.:/]+$/;

// validate one filter value against the token charset; a clear, field-named error
function safeFilter(field: string, value: string): string {
    if (!TOKEN_CHARSET.test(value)) throw new Error(`--${field} has an illegal character (token charset only)`);
    return value;
}

// build the ssh argv for a remote tail: [target, '<fixed uc invocation>']. The
// remote command is ONE string the hub shell runs; filter values are charset-
// validated (never quoted into it as arbitrary text) so there is no injection.
export function buildTailArgs(target: string, filters: RemoteTailFilters): string[] {
    // start from the fixed invocation — --json so the hub emits the line-JSON contract
    const parts = ['uc event tail --json'];

    // (the ssh argv is assembled at the end, leading with SSH_HARDENING)

    // limit must be an integer (no NaN / float leaking into the remote command)
    if (filters.limit !== undefined) {
        if (!Number.isInteger(filters.limit)) throw new Error('--limit must be an integer');
        parts.push(`--limit ${filters.limit}`);
    }

    // each filter is charset-validated, then appended in a fixed order
    if (filters.kind !== undefined) parts.push(`--kind ${safeFilter('kind', filters.kind)}`);
    if (filters.source !== undefined) parts.push(`--source ${safeFilter('source', filters.source)}`);
    if (filters.subject !== undefined) parts.push(`--subject ${safeFilter('subject', filters.subject)}`);

    // ssh argv: hardening flags first (fail-fast, no prompt), then target + the
    // LOGIN-shell wrapped command (so ~/.local/bin is on the remote PATH — BUG 2)
    return [...SSH_HARDENING, target, loginShellWrap(parts.join(' '))];
}

// the result of a remote tail: ok + the hub's stdout as trimmed line-JSON strings,
// or ok false carrying the ssh exit code + stderr for the caller to surface.
export type RemoteTailResult = { ok: boolean; lines: string[]; code: number; stderr: string };

// run `ssh <target> 'uc event tail --json …'` through the injectable runner. On
// exit 0 the stdout (already the line-JSON contract) is split into non-empty
// lines; a nonzero exit (hub down / `uc` missing) surfaces ok false honestly.
export async function remoteTail(target: string, filters: RemoteTailFilters, runner: StdinRunner): Promise<RemoteTailResult> {
    const { code, stdout, stderr } = await runner('ssh', buildTailArgs(target, filters));

    // split the hub stdout into trimmed, non-empty lines (the consumer contract)
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return { ok: code === 0, lines, code, stderr };
}

// -- ssh transport ------------------------------------------------------------

// build the SSH Deliver for a remote target — pipe the envelope to a hub `uc`.
function sshDeliver(target: string, runner: StdinRunner): Deliver {
    return async (envelopeJson) => {
        // hardening flags lead (fail fast, no prompt); the remote uc runs inside a
        // LOGIN shell so ~/.local/bin is on PATH (else exit 127 → row stays pending).
        const { code } = await runner('ssh', [...SSH_HARDENING, target, loginShellWrap('uc event commit --from-stdin')], envelopeJson);
        return code === 0;
    };
}

// -- http transport -----------------------------------------------------------

// the events endpoints on the unified api coord (works for `uc serve` AND cloud)
const eventsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/$/, '')}/events`;

// build the HTTP Deliver for an api coord — POST /events with the bearer key. A
// 2xx commits the envelope (returns true); any other status / network error keeps
// the row pending (false), exactly like the ssh path's nonzero-exit semantics.
function httpDeliver(api: RemoteApi, fetchImpl: typeof fetch): Deliver {
    return async (envelopeJson) => {
        try {
            const res = await fetchImpl(eventsUrl(api.baseUrl), {
                method: 'POST',
                headers: { Authorization: `Bearer ${api.apiKey}`, 'content-type': 'application/json' },
                body: envelopeJson,
            });
            return res.ok;
        } catch {
            return false;
        }
    };
}

// build the HTTP tail for an api coord — GET /events?limit/kind/source/subject.
// The serve endpoint answers a JSON ARRAY of envelopes (chronological); each is
// re-stringified into the SAME line-JSON contract the ssh tail + the consumer use.
function httpTail(api: RemoteApi, fetchImpl: typeof fetch): NonNullable<Transport['tail']> {
    return async (filters) => {
        // assemble the documented query params (limit + kind/source/subject)
        const params = new URLSearchParams();
        if (filters.limit !== undefined) params.set('limit', String(filters.limit));
        if (filters.kind !== undefined) params.set('kind', filters.kind);
        if (filters.source !== undefined) params.set('source', filters.source);
        if (filters.subject !== undefined) params.set('subject', filters.subject);

        // GET the tail array, surfacing a non-2xx / network error as ok false
        const qs = params.toString();
        const url = qs ? `${eventsUrl(api.baseUrl)}?${qs}` : eventsUrl(api.baseUrl);
        try {
            const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${api.apiKey}` } });
            if (!res.ok) return { ok: false, lines: [], code: res.status, stderr: `HTTP ${res.status}` };

            // the array of envelopes → one compact JSON object per line (the contract)
            const envelopes = (await res.json()) as unknown[];
            return { ok: true, lines: envelopes.map((e) => JSON.stringify(e)), code: 0, stderr: '' };
        } catch (error) {
            return { ok: false, lines: [], code: -1, stderr: (error as Error).message };
        }
    };
}

// -- resolution ---------------------------------------------------------------

// resolve the transport for the configured remote. SELECTION: an `api` coord →
// HTTP (the events endpoint, identical for `uc serve` + cloud); else a ssh remote
// → the ssh Deliver/tail; else local/absent config → local mode (never sends).
export async function resolveTransport(opts: { configDir?: string; runner?: StdinRunner; fetch?: typeof fetch } = {}): Promise<Transport> {
    const runner = opts.runner ?? spawnStdinRunner;
    const fetchImpl = opts.fetch ?? fetch;

    // the unified remote's api side wins for events — a serve/cloud endpoint over
    // HTTP removes the ssh-per-event + the login-PATH fragility entirely.
    const remote: RemoteConfig = await readRemote(opts.configDir).catch(() => ({}));
    if (remote.api) {
        const host = await syncHostId(opts.configDir);
        return {
            localMode: false,
            target: remote.api.baseUrl,
            host,
            deliver: httpDeliver(remote.api, fetchImpl),
            tail: httpTail(remote.api, fetchImpl),
        };
    }

    // a missing config means no hub is configured yet → default to local mode
    const config = await loadConfig(opts.configDir).catch(() => null);
    if (!config || isLocalConfig(config)) {
        return {
            localMode: true,
            target: 'local',
            host: config?.hostId ?? defaultHostId(hostname()),
            deliver: async () => true,
        };
    }

    // a ssh remote → events queue pending; the ssh Deliver retries them, the ssh
    // tail reads the hub's committed log over the login shell.
    return {
        localMode: false,
        target: config.remote,
        host: config.hostId,
        deliver: sshDeliver(config.remote, runner),
        tail: (filters) => remoteTail(config.remote, filters, runner),
    };
}

// the host id for the HTTP transport's status card: the sync config's hostId when
// present, else one derived from the machine hostname (no ssh hub to read it from).
async function syncHostId(configDir?: string): Promise<string> {
    const config = await loadConfig(configDir).catch(() => null);
    return config?.hostId ?? defaultHostId(hostname());
}
