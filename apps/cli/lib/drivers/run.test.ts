// =============================================================================
// run.test — runDriver resolves [commands][command] and executes it via sh -c.
// The real spawn is injected so tests assert the exact argv + returned code
// without buffering driver stdio. Asserts: resolves the shell string for the
// verb; a missing verb is a clear error listing the available commands; the
// child exit code is propagated; stdio is INHERITED (stream-through, no buffer).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runDriver, type Spawn } from './run';
import type { DriverManifest } from './manifest';

// -- fixtures -----------------------------------------------------------------

// a minimal manifest with safe shell verbs (echo → 0, false → 1)
const manifest: DriverManifest = {
    name: 'fix',
    version: '0.1.0',
    commands: { 'echo-cmd': 'echo hi', 'fail-cmd': 'false' },
    dir: '/tmp/drivers/fix',
};

// records every spawn invocation + the opts, replying a canned exit code
function recordingSpawn(code: number) {
    const calls: { program: string; args: string[]; opts: unknown }[] = [];
    const spawn: Spawn = (program, args, opts) => {
        calls.push({ program, args, opts });
        return Promise.resolve(code);
    };
    return { spawn, calls };
}

// -- resolve + execute --------------------------------------------------------

describe('runDriver', () => {
    // resolves the verb's shell string and runs it via `sh -c <string>`
    it('runs the resolved command via sh -c', async () => {
        const rec = recordingSpawn(0);
        const code = await runDriver(manifest, 'echo-cmd', { spawn: rec.spawn });

        assert.equal(code, 0);
        assert.equal(rec.calls.length, 1);
        assert.equal(rec.calls[0].program, 'sh');
        assert.deepEqual(rec.calls[0].args, ['-c', 'echo hi']);
    });

    // stdio is INHERITED so driver output streams through (never buffered)
    it('inherits stdio (streams through)', async () => {
        const rec = recordingSpawn(0);
        await runDriver(manifest, 'echo-cmd', { spawn: rec.spawn });

        assert.deepEqual((rec.calls[0].opts as { stdio?: unknown }).stdio, 'inherit');
    });

    // the child's exit code is propagated verbatim (false → 1)
    it('propagates a nonzero exit code', async () => {
        const rec = recordingSpawn(1);
        const code = await runDriver(manifest, 'fail-cmd', { spawn: rec.spawn });

        assert.equal(code, 1);
    });

    // a missing verb is a clear error LISTING the available command names
    it('throws a clear error listing available commands for an unknown verb', async () => {
        const rec = recordingSpawn(0);
        await assert.rejects(
            () => runDriver(manifest, 'nope', { spawn: rec.spawn }),
            (err: Error) => {
                assert.match(err.message, /no command nope/);
                assert.match(err.message, /echo-cmd/);
                assert.match(err.message, /fail-cmd/);
                return true;
            },
        );
        // never spawned anything for an unresolved verb
        assert.equal(rec.calls.length, 0);
    });
});
