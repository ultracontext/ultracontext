// =============================================================================
// mutagen.test — the PURE Mutagen stdout parsers. Highest-value TDD target:
// feed real `mutagen sync list --long` output and assert SessionInfo[]. Also
// covers the lighter `sync list` helpers (session-name → status / exists).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseMutagenSessions,
    mutagenSessionStatus,
    mutagenSessionExists,
    ownedMutagenSessionNames,
} from './mutagen';

// -- sample `mutagen sync list --long` output ---------------------------------

// two sessions: one happily watching, one mid-transition with a problem
const LONG_OUTPUT = `--------------------------------------------------------------------------------
Name: uc-laptop-claude
Identifier: sync_abc123
Labels: None
Alpha:
        URL: /Users/fabio/.claude
        Connected: Yes
        Synchronizable contents:
                1234 files, 12 directories (45 MB)
Beta:
        URL: vps:~/.ultracontext/workspace/laptop/.claude
        Connected: Yes
        Synchronizable contents:
                1234 files, 12 directories (45 MB)
Status: Watching for changes
--------------------------------------------------------------------------------
Name: uc-laptop-codex
Identifier: sync_def456
Labels: None
Alpha:
        URL: /Users/fabio/.codex
        Connected: Yes
        Synchronizable contents:
                900 files (10 MB)
Beta:
        URL: vps:~/.ultracontext/workspace/laptop/.codex
        Connected: No
        Synchronizable contents:
                300 files (3 MB)
Status: Staging files on beta: 40% (300/900)
Transition problems:
        change applying failed for path "foo/bar.lock"
--------------------------------------------------------------------------------
`;

// -- parseMutagenSessions: structural correctness -----------------------------

describe('parseMutagenSessions', () => {
    // splits the blob into one SessionInfo per `Name:` block
    it('parses one session per Name block', () => {
        const sessions = parseMutagenSessions(LONG_OUTPUT);
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0].name, 'uc-laptop-claude');
        assert.equal(sessions[1].name, 'uc-laptop-codex');
    });

    // captures per-side URL + connected flag, keyed by Alpha:/Beta: headers
    it('captures alpha/beta urls and connection state', () => {
        const [claude] = parseMutagenSessions(LONG_OUTPUT);
        assert.equal(claude.alphaUrl, '/Users/fabio/.claude');
        assert.equal(claude.betaUrl, 'vps:~/.ultracontext/workspace/laptop/.claude');
        assert.equal(claude.alphaConnected, true);
        assert.equal(claude.betaConnected, true);
    });

    // pulls file counts + the parenthesized size for each side
    it('captures file counts and sizes per side', () => {
        const sessions = parseMutagenSessions(LONG_OUTPUT);
        assert.equal(sessions[0].alphaFiles, 1234);
        assert.equal(sessions[0].alphaSize, '45 MB');
        assert.equal(sessions[1].betaFiles, 300);
        assert.equal(sessions[1].betaSize, '3 MB');
    });

    // status line + inline percentage extraction
    it('captures status and progress percentage', () => {
        const sessions = parseMutagenSessions(LONG_OUTPUT);
        assert.equal(sessions[0].status, 'Watching for changes');
        assert.equal(sessions[0].progressPct, undefined);
        assert.equal(sessions[1].status, 'Staging files on beta: 40% (300/900)');
        assert.equal(sessions[1].progressPct, 40);
    });

    // transition problems accumulate under their header until the next section
    it('captures transition problems', () => {
        const sessions = parseMutagenSessions(LONG_OUTPUT);
        assert.equal(sessions[0].transitionProblems.length, 0);
        assert.deepEqual(sessions[1].transitionProblems, [
            'change applying failed for path "foo/bar.lock"',
        ]);
    });

    // empty / whitespace input yields no sessions
    it('returns [] for empty output', () => {
        assert.deepEqual(parseMutagenSessions(''), []);
        assert.deepEqual(parseMutagenSessions('   \n  \n'), []);
    });
});

// -- short `sync list` helpers ------------------------------------------------

// the cheaper `mutagen sync list` (no --long) only emits Name:/Status: lines
const SHORT_OUTPUT = `Name: uc-laptop-claude
Status: Watching for changes

Name: uc-laptop-codex
Status: Paused

Name: other-tool-xyz
Status: Watching for changes
`;

describe('mutagenSessionStatus', () => {
    // returns the Status: line that follows a matching Name:
    it('returns the status for a known session', () => {
        assert.equal(mutagenSessionStatus(SHORT_OUTPUT, 'uc-laptop-claude'), 'Watching for changes');
        assert.equal(mutagenSessionStatus(SHORT_OUTPUT, 'uc-laptop-codex'), 'Paused');
    });

    // unknown session → undefined
    it('returns undefined for an unknown session', () => {
        assert.equal(mutagenSessionStatus(SHORT_OUTPUT, 'uc-laptop-missing'), undefined);
    });
});

describe('mutagenSessionExists', () => {
    // presence test by exact Name: match
    it('detects present / absent sessions', () => {
        assert.equal(mutagenSessionExists(SHORT_OUTPUT, 'uc-laptop-codex'), true);
        assert.equal(mutagenSessionExists(SHORT_OUTPUT, 'nope'), false);
    });
});

describe('ownedMutagenSessionNames', () => {
    // only names with the `uc-<hostId>-` prefix are ours
    it('filters to sessions owned by this host', () => {
        const owned = ownedMutagenSessionNames(SHORT_OUTPUT, 'laptop');
        assert.deepEqual(owned, ['uc-laptop-claude', 'uc-laptop-codex']);
    });
});
