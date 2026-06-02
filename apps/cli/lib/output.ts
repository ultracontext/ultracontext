// =============================================================================
// output — pipe-aware emit. Data → stdout; spinners/status/logs → stderr.
// JSON when --json OR stdout is not a TTY; human otherwise.
// =============================================================================

import pc from 'picocolors';

// -- mode resolution ----------------------------------------------------------

// machine mode when --json is set or stdout is piped (not a TTY)
export function isMachine(jsonFlag?: boolean): boolean {
    return Boolean(jsonFlag) || !process.stdout.isTTY;
}

// -- data output (stdout) -----------------------------------------------------

// emit structured data — JSON line in machine mode, formatted text otherwise
export function emit(data: unknown, opts?: { json?: boolean; human?: (d: unknown) => string }): void {
    if (isMachine(opts?.json)) {
        process.stdout.write(JSON.stringify(data) + '\n');
        return;
    }

    process.stdout.write((opts?.human ? opts.human(data) : String(data)) + '\n');
}

// -- status output (stderr) ---------------------------------------------------

// human-facing status line — suppressed in machine mode to keep stdout clean
export function status(message: string): void {
    if (process.stdout.isTTY) {
        process.stderr.write(pc.dim(message) + '\n');
    }
}

// error line on stderr (always shown)
export function fail(message: string): void {
    process.stderr.write(pc.red(message) + '\n');
}
