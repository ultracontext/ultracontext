// =============================================================================
// auth — the serve single-user bearer model over the SAME local db the CLI's
// context verbs use. The minted key is bound to the 'local' project (so an
// authed request resolves to the project the verbs read/write), and only its
// HASH is stored — the raw key is shown ONCE at mint time. The minted prefix is
// remembered (serve.json) so a restart finds the existing key instead of
// re-minting + re-printing. verifyBearer is the per-request check.
// =============================================================================

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    generateKey,
    hashKey,
    verifyKey,
    KEY_PREFIX_LEN,
    type StorageAdapter,
} from '@ultracontext/core';

import { ensureProject } from '../context-resolver';
import { writeJsonAtomic, readJson } from '../config';

// -- serve key record ----------------------------------------------------------

// the ~/.ultracontext/serve.json slice — just the minted key's prefix, so a
// restart can detect "a key already exists" without re-minting (the raw key is
// never stored; only this prefix + the db hash). configDir is injectable so
// tests drive a temp dir without touching the real ~/.ultracontext.
const serveKeyPath = (configDir?: string): string =>
    join(configDir ?? join(homedir(), '.ultracontext'), 'serve.json');

// -- ensureServeKey ------------------------------------------------------------

// the outcome of ensuring a serve key: the resolved local project id, whether a
// key was freshly minted, and the raw key (PRESENT only on a fresh mint).
export type ServeKey = { projectId: number; minted: boolean; key?: string };

// find-or-mint the serve bearer key under the CLI's 'local' project. A remembered
// prefix that still resolves in the db → reuse (no re-mint, no raw key). Otherwise
// mint a fresh key, persist its prefix, and surface the raw key once.
export async function ensureServeKey(storage: StorageAdapter, configDir?: string): Promise<ServeKey> {
    // the key must live under the SAME project the context verbs use ('local'),
    // so an authenticated request resolves to that project's contexts.
    const projectId = await ensureProject(storage);

    // a remembered prefix that still exists in the db means a key is already
    // provisioned — reuse it (the raw key was shown at its original mint).
    const remembered = await readJson<{ prefix?: string }>(serveKeyPath(configDir));
    if (remembered?.prefix) {
        const existing = await storage.findApiKeyByPrefix(remembered.prefix);
        if (existing) return { projectId, minted: false };
    }

    // no usable key — mint a fresh one, persist only its hash + prefix
    const raw = generateKey();
    const prefix = raw.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(raw);
    await storage.insertApiKey({ project_id: projectId, key_prefix: prefix, key_hash: hash });

    // remember the prefix so the next start reuses this key (never re-prints it)
    await writeJsonAtomic(serveKeyPath(configDir), { prefix });

    return { projectId, minted: true, key: raw };
}

// -- verifyBearer --------------------------------------------------------------

// the resolved request identity — just the project the token unlocks
export type Verified = { projectId: number };

// verify a bearer token against the db; null on missing/bad. Delegates to core
// verifyKey (prefix lookup + full-token hash compare), surfacing only the project.
export async function verifyBearer(storage: StorageAdapter, token: string): Promise<Verified | null> {
    const verified = await verifyKey(storage, token);
    return verified ? { projectId: verified.projectId } : null;
}
