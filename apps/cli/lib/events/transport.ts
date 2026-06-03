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

// -- resolution ---------------------------------------------------------------

// build the SSH Deliver for a remote target — pipe the envelope to a hub `uc`.
function sshDeliver(target: string, runner: StdinRunner): Deliver {
    return async (envelopeJson) => {
        const { code } = await runner('ssh', [target, 'uc event commit --from-stdin'], envelopeJson);
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
