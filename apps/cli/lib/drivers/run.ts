// =============================================================================
// run — execute one driver command. Resolves [commands][command] from a parsed
// manifest and runs the shell string via `sh -c`, INHERITING stdio so the
// driver's stdout/stderr stream straight through (driver output is not
// load-bearing — events are — so we never buffer or swallow it). The child exit
// code is returned verbatim. The spawn is injectable so tests skip real procs.
//
// cwd: the 2.0 reference (lib.rs ~:1665 `external_command("sh").status()`) sets
// NO cwd, inheriting the caller's process cwd; manifest `~/` paths are expanded
// by the shell from HOME. We mirror that exactly — no cwd override here.
// =============================================================================

import { spawn as nodeSpawn } from 'node:child_process';

import type { DriverManifest } from './manifest';

// -- injectable spawn ---------------------------------------------------------

// runs a program with args + spawn opts, resolving the child's exit code. The
// seam lets tests assert argv + opts without launching a real process.
export type Spawn = (program: string, args: string[], opts: { stdio: 'inherit' }) => Promise<number>;

// the real spawn: inherit stdio (stream through), resolve on exit, reject only
// if the binary couldn't launch at all.
export const nodeSpawnRunner: Spawn = (program, args, opts) =>
    new Promise((resolve, reject) => {
        const child = nodeSpawn(program, args, opts);
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 0));
    });

// -- run ----------------------------------------------------------------------

// deps: the injectable spawn (defaults to the real inherit-stdio runner)
export type RunDeps = { spawn?: Spawn };

// resolve the verb → shell string and execute it via `sh -c`. A missing verb is
// a clear error listing the available commands. Returns the child exit code.
export async function runDriver(manifest: DriverManifest, command: string, deps: RunDeps = {}): Promise<number> {
    // resolve the command verb; an unknown verb lists what IS available
    const shellCommand = manifest.commands[command];
    if (shellCommand === undefined) {
        const available = Object.keys(manifest.commands).sort().join(', ') || '(none)';
        throw new Error(`driver ${manifest.name} has no command ${command}. Available: ${available}`);
    }

    // execute via sh -c, streaming the driver's stdio through (never buffered)
    const spawn = deps.spawn ?? nodeSpawnRunner;
    return spawn('sh', ['-c', shellCommand], { stdio: 'inherit' });
}
