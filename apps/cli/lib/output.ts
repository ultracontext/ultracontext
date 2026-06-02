// =============================================================================
// output — pipe-aware emit. Data → stdout; spinners/status/errors → stderr.
// JSON when --json OR stdout is not a TTY; human otherwise.
// Streams + tty are injectable so the json-vs-human decision is testable.
// =============================================================================

import pc from 'picocolors';

// -- injectable io ------------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams + tty are the defaults
type Io = { stdout?: Writable; stderr?: Writable; isTTY?: boolean };

// resolve io overrides against the live process streams
function resolveIo(io?: Io) {
    return {
        stdout: io?.stdout ?? process.stdout,
        stderr: io?.stderr ?? process.stderr,
        isTTY: io?.isTTY ?? Boolean(process.stdout.isTTY),
    };
}

// -- mode resolution ----------------------------------------------------------

// machine mode when --json is set or stdout is piped (not a TTY)
export function shouldJson(opts?: { json?: boolean }, io?: Io): boolean {
    const { isTTY } = resolveIo(io);
    return Boolean(opts?.json) || !isTTY;
}

// -- data output (stdout) -----------------------------------------------------

// emit structured data — JSON line in machine mode, formatted text otherwise
export function emit(
    data: unknown,
    opts?: { json?: boolean; human?: (d: unknown) => string },
    io?: Io,
): void {
    const { stdout, isTTY } = resolveIo(io);

    // machine mode → one JSON line on stdout, nothing on stderr
    if (shouldJson(opts, { isTTY })) {
        stdout.write(JSON.stringify(data) + '\n');
        return;
    }

    // human mode → render via the formatter (or stringify) on stdout
    stdout.write((opts?.human ? opts.human(data) : String(data)) + '\n');
}

// -- status output (stderr) ---------------------------------------------------

// human-facing status line — stderr only, suppressed in machine mode
export function status(message: string, io?: Io): void {
    const { stderr, isTTY } = resolveIo(io);
    if (isTTY) stderr.write(pc.dim(message) + '\n');
}

// -- error output (stderr) ----------------------------------------------------

// a thrown clack cancel surfaces as a marker with code 'cancel'
function isCancel(error: unknown): boolean {
    return Boolean(error) && (error as { code?: string }).code === 'cancel';
}

// write a failure to stderr and return the process exit code (1, or 130 cancel)
export function outputError(error: unknown, io?: Io & { json?: boolean }): number {
    const { stderr } = resolveIo(io);

    // user cancellation → exit 130, quiet line
    if (isCancel(error)) {
        stderr.write(pc.dim('cancelled') + '\n');
        return 130;
    }

    // normal failure → exit 1; JSON envelope in machine mode, red line otherwise
    const message = error instanceof Error ? error.message : String(error);
    if (io?.json) {
        stderr.write(JSON.stringify({ error: message }) + '\n');
    } else {
        stderr.write(pc.red(message) + '\n');
    }
    return 1;
}
