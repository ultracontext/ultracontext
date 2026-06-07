// =============================================================================
// mutagen — a thin wrapper over the `mutagen` binary plus PURE parsers for its
// stdout. The orchestration in sync.ts shells out through CommandRunner; the
// parsers here are side-effect-free so they can be hammered in tests.
// =============================================================================

import { spawn } from 'node:child_process';

// -- parsed session shape -----------------------------------------------------

// one entry per `Name:` block in `mutagen sync list --long`
export type SessionInfo = {
    name: string;
    alphaUrl: string;
    betaUrl: string;
    alphaFiles?: number;
    betaFiles?: number;
    alphaSize: string;
    betaSize: string;
    alphaConnected: boolean;
    betaConnected: boolean;
    status: string;
    progressPct?: number;
    transitionProblems: string[];
};

// a fresh, all-defaults session record for the given name
function emptySession(name: string): SessionInfo {
    return {
        name,
        alphaUrl: '',
        betaUrl: '',
        alphaSize: '',
        betaSize: '',
        alphaConnected: false,
        betaConnected: false,
        status: '',
        transitionProblems: [],
    };
}

// -- long-list parser ---------------------------------------------------------

// parse `mutagen sync list --long` output into one SessionInfo per session
export function parseMutagenSessions(out: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    let cur: SessionInfo | null = null;
    let side: 'alpha' | 'beta' | null = null;
    let inProblems = false;

    for (const raw of out.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        const trimmed = line.trimStart();

        // dashed separators delimit sessions — skip them and end problem capture
        if (trimmed.length > 0 && /^-+$/.test(trimmed)) {
            inProblems = false;
            continue;
        }

        // a new `Name:` line closes the previous session and opens a fresh one
        const name = stripPrefix(trimmed, 'Name: ');
        if (name !== null) {
            if (cur) sessions.push(cur);
            cur = emptySession(name);
            side = null;
            inProblems = false;
            continue;
        }

        // every other line only matters once we're inside a session block
        if (!cur) continue;

        // status carries the human state + maybe an inline percentage
        const status = stripPrefix(trimmed, 'Status: ');
        if (status !== null) {
            cur.status = status;
            cur.progressPct = parseProgressPct(status);
            inProblems = false;
            continue;
        }

        // transition problems accumulate under their header until the next field
        if (trimmed === 'Transition problems:') {
            inProblems = true;
            continue;
        }
        if (inProblems) {
            if (trimmed) cur.transitionProblems.push(trimmed);
            continue;
        }

        // Alpha:/Beta: headers select which side subsequent fields apply to
        if (trimmed === 'Alpha:') { side = 'alpha'; continue; }
        if (trimmed === 'Beta:') { side = 'beta'; continue; }

        // per-side endpoint URL
        const url = stripPrefix(trimmed, 'URL: ');
        if (url !== null) {
            if (side === 'alpha') cur.alphaUrl = url;
            else if (side === 'beta') cur.betaUrl = url;
            continue;
        }

        // per-side connection flag
        const connected = stripPrefix(trimmed, 'Connected: ');
        if (connected !== null) {
            const yes = connected.toLowerCase() === 'yes';
            if (side === 'alpha') cur.alphaConnected = yes;
            else if (side === 'beta') cur.betaConnected = yes;
            continue;
        }

        // symbolic-link summary lines are noise — skip them explicitly
        if (trimmed.endsWith(' symbolic links')) continue;

        // a `<n> files[, <m> directories] (<size>)` line carries count + size
        if (/^\d+\s+files\b/.test(trimmed)) {
            const count = Number(trimmed.split(/\s+/)[0]) || 0;
            const size = trimmed.match(/\(([^)]*)\)/)?.[1] ?? '';
            if (side === 'alpha') { cur.alphaFiles = count; cur.alphaSize = size; }
            else if (side === 'beta') { cur.betaFiles = count; cur.betaSize = size; }
            continue;
        }
    }

    // flush the trailing session
    if (cur) sessions.push(cur);
    return sessions;
}

// pull the integer percentage immediately preceding a `%` in the status line
function parseProgressPct(status: string): number | undefined {
    const idx = status.indexOf('%');
    if (idx < 0) return undefined;

    const digits = status.slice(0, idx).match(/(\d+)$/)?.[1];
    return digits ? Number(digits) : undefined;
}

// -- short-list helpers -------------------------------------------------------

// the status that follows a matching `Name:` in plain `mutagen sync list`
export function mutagenSessionStatus(list: string, name: string): string | undefined {
    let inSession = false;

    for (const raw of list.split('\n')) {
        const trimmed = raw.trim();

        const sessionName = stripPrefix(trimmed, 'Name: ');
        if (sessionName !== null) {
            inSession = sessionName === name;
            continue;
        }

        const status = stripPrefix(trimmed, 'Status: ');
        if (inSession && status !== null) return status;
    }

    return undefined;
}

// whether a session with this exact name appears in the list
export function mutagenSessionExists(list: string, name: string): boolean {
    return sessionNames(list).includes(name);
}

// names owned by this host — those prefixed `uc-<hostId>-`
export function ownedMutagenSessionNames(list: string, hostId: string): string[] {
    const prefix = `uc-${hostId}-`;
    return sessionNames(list).filter((name) => name.startsWith(prefix));
}

// every `Name:` value in a list blob
function sessionNames(list: string): string[] {
    const names: string[] = [];
    for (const raw of list.split('\n')) {
        const name = stripPrefix(raw.trim(), 'Name: ');
        if (name !== null) names.push(name);
    }
    return names;
}

// -- small string helper ------------------------------------------------------

// return the suffix after `prefix`, or null when the value doesn't start with it
function stripPrefix(value: string, prefix: string): string | null {
    return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

// -- command runner (injectable for tests) ------------------------------------

// the result of running an external command
export type CommandResult = { code: number; stdout: string; stderr: string };

// runs a program with args — the seam fakes inject so tests skip the binary
export type CommandRunner = (program: string, args: string[]) => Promise<CommandResult>;

// the real runner: spawn the process and collect its stdio
export const spawnRunner: CommandRunner = (program, args) =>
    new Promise((resolve, reject) => {
        const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // accumulate both streams
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        // resolve on exit, reject if the binary couldn't be launched at all
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
