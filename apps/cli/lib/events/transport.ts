// =============================================================================
// transport — resolve the event hub from the EXISTING sync config and build the
// pluggable Deliver. SSH is never mandatory: a 'local' (or missing) config →
// localMode (emit IS the commit, in-db). A ssh remote → a Deliver that runs
// `ssh <host> 'uc event commit --from-stdin'` piping the envelope JSON to stdin.
// The runner is INJECTABLE (a stdin-capable spawn) so tests never hit real SSH.
// =============================================================================

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { loadConfig, isLocalConfig, defaultHostId, type CommandResult } from '@ultracontext/sync';

import type { Deliver } from '@ultracontext/core';

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
// target + host id, and a Deliver the flusher retries pending rows through.
export type Transport = {
    localMode: boolean;
    target: string;
    host: string;
    deliver: Deliver;
};

// -- ssh hardening ------------------------------------------------------------

// flags every ssh hop leads with (matches the ios-relay guide's BatchMode hop).
// BatchMode=yes never prompts for a password — an unreachable / auth-failing hub
// fails fast instead of blocking on a TTY prompt. ConnectTimeout bounds the TCP
// connect so an unroutable host errors in seconds, not the OS's ~75s+ default.
export const SSH_HARDENING = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

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

    // ssh argv: hardening flags first (fail-fast, no prompt), then target + command
    return [...SSH_HARDENING, target, parts.join(' ')];
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

// -- resolution ---------------------------------------------------------------

// build the SSH Deliver for a remote target — pipe the envelope to a hub `uc`.
function sshDeliver(target: string, runner: StdinRunner): Deliver {
    return async (envelopeJson) => {
        // lead with the hardening flags so a down/auth-failing hub fails fast (no prompt)
        const { code } = await runner('ssh', [...SSH_HARDENING, target, 'uc event commit --from-stdin'], envelopeJson);
        return code === 0;
    };
}

// resolve the transport from the sync config dir. local/absent config → local
// mode; a ssh remote → remote mode with the ssh Deliver. localMode never sends.
export async function resolveTransport(opts: { configDir?: string; runner?: StdinRunner } = {}): Promise<Transport> {
    const runner = opts.runner ?? spawnStdinRunner;

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

    // a ssh remote → events queue pending; the ssh Deliver retries them
    return {
        localMode: false,
        target: config.remote,
        host: config.hostId,
        deliver: sshDeliver(config.remote, runner),
    };
}
