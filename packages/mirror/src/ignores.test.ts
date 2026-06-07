// =============================================================================
// ignores.test — the ignore-file subsystem: a GLOBAL ignore file seeded with
// the 2.0 defaults on first use, plus per-source files, both merged into a
// repeated `--ignore=` pattern list. All fs goes to a temp configDir, never $HOME.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    ensureIgnoreFiles,
    ignorePath,
    sourceIgnorePath,
    collectIgnorePatterns,
} from './ignores';

// -- temp dirs ----------------------------------------------------------------

// track temp config dirs so we can clean them all up at the end of the suite
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-sync-ign-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- path helpers -------------------------------------------------------------

describe('ignore paths', () => {
    // the global ignore file lives at <dir>/ignores/.ultracontextignore
    it('builds the global ignore path', () => {
        const dir = '/tmp/cfg';
        assert.equal(ignorePath(dir), join(dir, 'ignores', '.ultracontextignore'));
    });

    // a per-source ignore file lives at <dir>/ignores/<source>/.ultracontextignore
    it('builds a per-source ignore path', () => {
        const dir = '/tmp/cfg';
        assert.equal(sourceIgnorePath(dir, 'claude'), join(dir, 'ignores', 'claude', '.ultracontextignore'));
    });
});

// -- seeding ------------------------------------------------------------------

describe('ensureIgnoreFiles', () => {
    // first call seeds the global ignore file with the 2.0 defaults
    it('seeds the global ignore file when absent', async () => {
        const dir = await tempDir();
        await ensureIgnoreFiles({ configDir: dir });

        const raw = await readFile(ignorePath(dir), 'utf8');
        // a representative sample of the ported defaults
        assert.match(raw, /\.git\//);
        assert.match(raw, /node_modules\//);
        assert.match(raw, /\.DS_Store/);
        assert.match(raw, /\*\.sqlite-wal/);
    });

    // an existing global ignore file is left untouched (no clobber)
    it('does not overwrite an existing global ignore file', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, 'ignores'), { recursive: true });
        await writeFile(ignorePath(dir), '# mine\ncustom/\n', 'utf8');

        await ensureIgnoreFiles({ configDir: dir });

        const raw = await readFile(ignorePath(dir), 'utf8');
        assert.equal(raw, '# mine\ncustom/\n');
    });
});

// -- pattern collection -------------------------------------------------------

describe('collectIgnorePatterns', () => {
    // merges global + per-source patterns, skipping blanks and # comments
    it('merges global and per-source patterns', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, 'ignores', 'claude'), { recursive: true });
        await writeFile(ignorePath(dir), '# global\n.git/\n\nnode_modules/\n', 'utf8');
        await writeFile(sourceIgnorePath(dir, 'claude'), '# source\nsecrets/\n', 'utf8');

        const patterns = await collectIgnorePatterns({ configDir: dir }, 'claude');

        assert.deepEqual(patterns, ['.git/', 'node_modules/', 'secrets/']);
    });

    // a missing ignore file yields no patterns and never throws
    it('returns no patterns when files are absent', async () => {
        const dir = await tempDir();
        const patterns = await collectIgnorePatterns({ configDir: dir }, 'codex');
        assert.deepEqual(patterns, []);
    });

    // whitespace around patterns is trimmed
    it('trims surrounding whitespace', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, 'ignores'), { recursive: true });
        await writeFile(ignorePath(dir), '   *.log   \n', 'utf8');

        const patterns = await collectIgnorePatterns({ configDir: dir }, 'claude');
        assert.deepEqual(patterns, ['*.log']);
    });
});
