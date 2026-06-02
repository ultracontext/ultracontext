// =============================================================================
// version — `uc version`. Prints the CLI tool version. A dedicated subcommand
// (not Commander's global --version) so the `--version <n>` selector on the
// context verbs is free to time-travel instead of being shadowed by the CLI's
// own version flag. Pipe-aware: a bare string in human mode, a JSON envelope
// with --json. Data → stdout.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { VERSION } from '../../../lib/version';
import { emit } from '../../../lib/output';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Runtime = { io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean } };

// -- handler ------------------------------------------------------------------

// emit the CLI version — bare string in human mode, { version } JSON otherwise
export function runVersion(opts: { json?: boolean }, runtime: Runtime = {}): number {
    emit({ version: VERSION }, { json: opts.json, human: () => VERSION }, runtime.io);
    return 0;
}

// -- command factory ----------------------------------------------------------

// `uc version` — discoverable tool version without shadowing the verb selector
export function buildVersionCommand(): Command {
    const command = new Command('version');

    command
        .description('print the uc CLI version')
        .action((_opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
            process.exitCode = runVersion({ json });
        });

    return command;
}
