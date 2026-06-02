// =============================================================================
// version.test — `uc version` prints the CLI tool version WITHOUT shadowing the
// `--version <n>` selector on the context verbs. Drives the real program via
// buildProgram() so the subcommand wiring + the global --version absence are
// exercised together.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runVersion } from './version';
import { VERSION } from '../../../lib/version';
import { buildProgram } from '../main';

// -- capture sink -------------------------------------------------------------

// a buffer-backed io pair so we can assert exactly what landed on stdout
function captureIo(isTTY: boolean) {
    let stdout = '';
    let stderr = '';
    return {
        io: {
            stdout: { write: (s: string) => ((stdout += s), true) },
            stderr: { write: (s: string) => ((stderr += s), true) },
            isTTY,
        },
        out: () => stdout,
        err: () => stderr,
    };
}

// -- handler ------------------------------------------------------------------

describe('runVersion', () => {
    // human mode prints the bare version string (no JSON envelope)
    it('prints the bare version string in human mode', () => {
        const cap = captureIo(true);
        const code = runVersion({}, { io: cap.io });
        assert.equal(code, 0);
        assert.equal(cap.out().trim(), VERSION);
    });

    // --json emits a { version } envelope on stdout
    it('emits a { version } JSON envelope with --json', () => {
        const cap = captureIo(false);
        const code = runVersion({ json: true }, { io: cap.io });
        assert.equal(code, 0);
        assert.equal(JSON.parse(cap.out().trim()).version, VERSION);
    });
});

// -- no global --version flag (argv) ------------------------------------------

describe('uc has no global --version flag', () => {
    // the root program must NOT register Commander's global --version — it would
    // shadow the `--version <n>` selector on get/create
    it('does not register a -V/--version option on the root', () => {
        const flags = buildProgram().options.map((o) => o.long);
        assert.ok(!flags.includes('--version'), 'root must not carry a global --version');
    });

    // `uc version` is the discoverable tool-version surface instead
    it('registers a `version` subcommand', () => {
        const names = buildProgram().commands.map((c) => c.name());
        assert.ok(names.includes('version'), 'version subcommand not registered');
    });
});
