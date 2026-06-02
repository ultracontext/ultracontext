// =============================================================================
// temp-db — fixtures for lib tests. libsql ':memory:' does NOT share tables
// across connections, so every test uses a real temp file (auto-cleaned).
// =============================================================================

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// -- temp file tracking -------------------------------------------------------

// collect created files so a single afterAll can remove them + their wal/shm
const created: string[] = [];

// a unique libsql `file:` url under the OS temp dir
export function tempDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-cli-${process.pid}-${created.length}-${Date.now()}.db`);
    created.push(file);
    return 'file:' + file;
}

// remove every temp db (and its sidecar wal/shm files), ignoring missing ones
export function cleanupTempDbs(): void {
    for (const url of created) {
        const file = url.replace(/^file:/, '');
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(file + ext); } catch { /* ignore */ }
        }
    }
}
