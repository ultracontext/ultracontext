// =============================================================================
// createLocalClient — the NODE factory for the local ContextClient. Opens a
// libsql/bun-sqlite adapter at a `file:` (or :memory:/remote) url, ensures the
// single 'local' project, then hands both to the pure, browser-safe
// LocalContextClient (./local-client). The node-only bits (ensureDbDir over
// node:path/node:fs) live HERE so the shared class stays import-pure.
// =============================================================================

import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { ContextClient } from '../context-client';
import { ensureProject } from '../context-resolver';
import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

import { LocalContextClient } from './local-client';

// -- factory ------------------------------------------------------------------

// ensure a `file:` db url's parent dir exists — on a fresh HOME ~/.ultracontext
// is absent, and libsql fails with SQLITE_CANTOPEN(14) opening into a missing
// dir. :memory: and remote (libsql://, http) urls have no local dir to create.
async function ensureDbDir(dbUrl: string): Promise<void> {
    if (!dbUrl.startsWith('file:')) return;
    await mkdir(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

// open the local adapter + ensure the project, then build the client.
// cwd is accepted for signature compatibility but no longer drives a default
// context — every verb targets an explicit id.
export async function createLocalClient(opts: { dbUrl: string; cwd?: string }): Promise<ContextClient> {
    await ensureDbDir(opts.dbUrl);
    const storage = await createSqliteAdapter(opts.dbUrl);
    const projectId = await ensureProject(storage);
    return new LocalContextClient(storage, projectId);
}
