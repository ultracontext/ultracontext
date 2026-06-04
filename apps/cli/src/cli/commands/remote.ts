// =============================================================================
// remote — the top-level `uc remote <set|show|test|clear>`. ONE central machine
// configured once, carrying the coordinates each primitive needs: an ssh side
// (fs sync + the event transport) and an api side (contexts/events over HTTP).
// This is the SINGLE writer of the unified remote view over config.json — sync
// and the client resolver only READ it. Pipe-aware: data → stdout (JSON in
// machine mode), status/errors → stderr. Actions take an injectable configDir +
// ssh runner + fetch so reachability tests never hit real SSH or the network.
// =============================================================================

import { Command } from '@commander-js/extra-typings';
import { hostname } from 'node:os';

import { parseRemoteSpec, defaultHostId } from '@ultracontext/sync';

import { readRemote, writeRemote, clearRemote, type RemoteConfig } from '../../../lib/remote';
import { SSH_HARDENING, loginShellWrap, spawnStdinRunner, type StdinRunner } from '../../../lib/events/transport';
import { emit, status, outputError, shouldJson } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// deps every action reads: the config dir + the ssh runner + fetch seams + io.
// the configDir/runner/fetch overrides let tests drive a temp dir + a fake ssh
// runner + a stub fetch; the defaults use ~/.ultracontext + real ssh + global fetch.
export type RemoteDeps = { configDir?: string; runner?: StdinRunner; fetch?: typeof fetch; io?: Io };

// -- options ------------------------------------------------------------------

// the global --json flag flows in from the program root
type JsonOpt = { json?: boolean };

// `uc remote set` flags — the ssh root/host id + the optional api coordinate
export type RemoteSetOpts = JsonOpt & { root?: string; hostId?: string; api?: string; key?: string };

// -- set ----------------------------------------------------------------------

// `uc remote set <target> [--root] [--host-id] [--api] [--key]` → merge the ssh
// side (from the target spec) and/or the api side onto the unified remote. Either
// side is optional, so you can set ssh now and add the api coordinate later.
export async function remoteSetAction(target: string, opts: RemoteSetOpts, deps: RemoteDeps = {}): Promise<number> {
    try {
        // the ssh side: parse the `target[:root]` spec, override the root/host id
        const spec = parseRemoteSpec(target);
        const ssh = { target: spec.target, root: opts.root ?? spec.root, hostId: opts.hostId ?? defaultHostId(hostname()) };
        const remote: RemoteConfig = { ssh };

        // the api side is added only when BOTH the url and key are supplied
        if (opts.api && opts.key) remote.api = { baseUrl: opts.api, apiKey: opts.key };

        // merge onto the existing config (preserves sources + the untouched side)
        await writeRemote(remote, deps.configDir);

        emit({ ok: true, ssh: ssh.target, api: remote.api?.baseUrl ?? null }, { json: opts.json, human: () => `remote set → ${ssh.target}` }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- show ---------------------------------------------------------------------

// the redacted view `show` emits — the api key is replaced by a keySet boolean
type RemoteView = {
    ssh: { target: string; root: string; hostId: string } | null;
    api: { baseUrl: string; keySet: boolean } | null;
};

// project the unified remote into the redacted view (NEVER carries the key)
function redact(remote: RemoteConfig): RemoteView {
    return {
        ssh: remote.ssh ? { target: remote.ssh.target, root: remote.ssh.root, hostId: remote.ssh.hostId } : null,
        api: remote.api ? { baseUrl: remote.api.baseUrl, keySet: Boolean(remote.api.apiKey) } : null,
    };
}

// `uc remote show` → the unified remote, key redacted to a keySet boolean
export async function remoteShowAction(opts: JsonOpt, deps: RemoteDeps = {}): Promise<number> {
    try {
        const view = redact(await readRemote(deps.configDir));
        emit({ data: view }, { json: opts.json, human: () => humanShow(view) }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// render the redacted view as terse human lines (no remote → a hint)
function humanShow(view: RemoteView): string {
    if (!view.ssh && !view.api) return 'no remote configured — run `uc remote set <target>`';

    const lines: string[] = [];
    if (view.ssh) lines.push(`ssh  ${view.ssh.target}  root=${view.ssh.root}  host=${view.ssh.hostId}`);
    if (view.api) lines.push(`api  ${view.api.baseUrl}  key=${view.api.keySet ? 'set' : 'unset'}`);
    return lines.join('\n');
}

// -- test ---------------------------------------------------------------------

// one reachability leg result — the leg name, ok, and a human message
type Leg = { leg: 'ssh' | 'api'; ok: boolean; message: string };

// `uc remote test` → probe each configured leg. ssh: `ssh <hardening> <target>
// 'bash -lc "uc --version"'` (the login-shell wrap is the check that catches the
// hub-PATH bug); api: GET the base url. Exit 1 if any configured leg fails.
export async function remoteTestAction(opts: JsonOpt, deps: RemoteDeps = {}): Promise<number> {
    try {
        const remote = await readRemote(deps.configDir);

        // nothing configured at all → a clear, actionable error
        if (!remote.ssh && !remote.api) throw new Error('no remote configured — run `uc remote set <target>`');

        // probe each configured leg, then summarize ok/fail across them
        const legs: Leg[] = [];
        if (remote.ssh && remote.ssh.target !== 'local') legs.push(await testSsh(remote.ssh.target, deps.runner ?? spawnStdinRunner));
        if (remote.api) legs.push(await testApi(remote.api.baseUrl, deps.fetch ?? fetch));

        // an unreachable leg makes the whole probe fail (exit 1)
        const ok = legs.every((leg) => leg.ok);
        emit({ data: { ok, legs } }, { json: opts.json, human: () => legs.map((l) => `${l.leg}  ${l.ok ? 'ok' : 'FAIL'}  ${l.message}`).join('\n') }, deps.io);
        return ok ? 0 : 1;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// probe the ssh leg: run a remote `uc --version` through the LOGIN shell (so
// ~/.local/bin is on PATH — the hub-PATH bug guard) with the fail-fast hardening.
async function testSsh(target: string, runner: StdinRunner): Promise<Leg> {
    const { code, stderr } = await runner('ssh', [...SSH_HARDENING, target, loginShellWrap('uc --version')]);
    return code === 0
        ? { leg: 'ssh', ok: true, message: `reachable (${target})` }
        : { leg: 'ssh', ok: false, message: `unreachable (${target}): ${stderr.trim() || `exit ${code}`}` };
}

// probe the api leg: GET the base url and treat any HTTP response as reachable
// (a network error is the only real failure — a 4xx still proves the host answers).
async function testApi(baseUrl: string, fetchImpl: typeof fetch): Promise<Leg> {
    try {
        const res = await fetchImpl(baseUrl);
        return { leg: 'api', ok: true, message: `reachable (${baseUrl}, HTTP ${res.status})` };
    } catch (error) {
        return { leg: 'api', ok: false, message: `unreachable (${baseUrl}): ${(error as Error).message}` };
    }
}

// -- clear --------------------------------------------------------------------

// `uc remote clear` → drop every remote coordinate, leaving sources intact
export async function remoteClearAction(opts: JsonOpt, deps: RemoteDeps = {}): Promise<number> {
    try {
        await clearRemote(deps.configDir);
        emit({ ok: true }, { json: opts.json, human: () => 'remote cleared (sources kept)' }, deps.io);
        return 0;
    } catch (error) {
        return outputError(error, { ...deps.io, json: shouldJson({ json: opts.json }, deps.io) });
    }
}

// -- commander bridge ---------------------------------------------------------

// the minimal Command surface the bridge reads (any subcommand arg/opt shape)
type AnyCommand = { optsWithGlobals(): unknown };

// read the global --json flag off any command in the tree
function jsonFlag(cmd: AnyCommand): boolean {
    return Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
}

// run an action with live process io, exiting non-zero on its returned code
function bridge(run: (json: boolean) => Promise<number>) {
    return async (cmd: AnyCommand) => {
        const code = await run(jsonFlag(cmd));
        if (code !== 0) process.exit(code);
    };
}

// -- command factory ----------------------------------------------------------

// build the `remote` Commander group with every subcommand wired to its action
export function buildRemoteCommand(): Command {
    const remote = new Command('remote').description('configure your one central remote (ssh + api)');

    // set — write the ssh side (from a target) and/or the api side
    remote
        .command('set')
        .description('set the remote coordinates (ssh target + optional api)')
        .argument('<target>', 'local | user@host[:root]')
        .option('--root <path>', 'remote workspace root (default ~/.ultracontext)')
        .option('--host-id <id>', 'override the derived host id')
        .option('--api <url>', 'hosted/self-host API base url')
        .option('--key <token>', 'API key (paired with --api)')
        .action((target, opts, cmd) =>
            bridge((json) => remoteSetAction(target, { json, root: opts.root, hostId: opts.hostId, api: opts.api, key: opts.key }))(cmd),
        );

    // show — the unified remote, key redacted to a keySet boolean
    remote.command('show').description('show the configured remote (key never printed)').action((_opts, cmd) => bridge((json) => remoteShowAction({ json }))(cmd));

    // test — reachability of each configured leg (ssh + api)
    remote.command('test').description('test reachability of the configured remote').action((_opts, cmd) => bridge((json) => remoteTestAction({ json }))(cmd));

    // clear — drop the remote coords (sources are kept)
    remote.command('clear').description('clear the remote coordinates (sources kept)').action((_opts, cmd) => bridge((json) => remoteClearAction({ json }))(cmd));

    return remote as unknown as Command;
}
