// =============================================================================
// store — open the events EventStore. Events live in the SAME local db the
// context verbs use (UC_DB_URL else ~/.ultracontext/uc.db). The sqlite adapter
// implements BOTH StorageAdapter and EventStore, so we open it once and hand
// the EventStore face to the core event ops. Mirrors clients/local.ts's
// ensureDbDir so a fresh ~/.ultracontext never trips SQLITE_CANTOPEN.
// =============================================================================

import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

import type { EventStore } from '@ultracontext/core';

// -- db dir -------------------------------------------------------------------

// ensure a `file:` db url's parent dir exists — libsql fails SQLITE_CANTOPEN(14)
// opening into a missing dir. :memory:/remote urls have no local dir to create.
async function ensureDbDir(dbUrl: string): Promise<void> {
    if (!dbUrl.startsWith('file:')) return;
    await mkdir(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

// -- open ---------------------------------------------------------------------

// open the local sqlite adapter and hand back its EventStore face
export async function openEventStore(dbUrl: string): Promise<EventStore> {
    await ensureDbDir(dbUrl);
    return createSqliteAdapter(dbUrl);
}
