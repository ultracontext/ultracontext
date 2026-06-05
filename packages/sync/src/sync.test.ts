// =============================================================================
// sync.test — start/stop/status/reset/list orchestration against a FAKE
// mutagen (an injected CommandRunner that records invocations + returns canned
// stdout). No real binary, no network. Each test gets a temp config + a fake.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig, loadConfig, type Config } from './config';
import {
    syncStart,
    syncStop,
    syncStatus,
    syncReset,
    syncList,
    sourceRemove,
    sourceSetEnabled,
    type SyncDeps,
} from './sync';
import { ignorePath, sourceIgnorePath } from './ignores';
import type { CommandResult } from './mutagen';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-sync-orc-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- fake mutagen + deps ------------------------------------------------------

// records every command and replies from a name→stdout map (default: empty list).
// `failCreate` makes any `mutagen sync create` return a non-zero exit + stderr.
function fakeRunner(responses: Record<string, string> = {}, opts: { failCreate?: string } = {}) {
    const calls: string[][] = [];

    const run = async (program: string, args: string[]): Promise<CommandResult> => {
        calls.push([program, ...args]);

        // a `sync list` reply is keyed by 'list' (long or short share the key)
        if (program === 'mutagen' && args[0] === 'sync' && args[1] === 'list') {
            return { code: 0, stdout: responses.list ?? '', stderr: '' };
        }

        // a `sync create` can be made to fail to exercise the visible-warning path
        if (opts.failCreate && program === 'mutagen' && args[0] === 'sync' && args[1] === 'create') {
            return { code: 1, stdout: '', stderr: opts.failCreate };
        }
        return { code: 0, stdout: '', stderr: '' };
    };

    return { run, calls };
}

// build SyncDeps around a fake runner; lets local-workspace paths exist under dir
function deps(configDir: string, runner: ReturnType<typeof fakeRunner>): SyncDeps {
    return {
        configDir,
        runCommand: runner.run,
        // pretend the mutagen binary + every local source path are present
        commandExists: async () => true,
        pathExists: async () => true,
    };
}

// a config whose sources all live locally — `local` skips ssh prep
async function seedLocalConfig(dir: string): Promise<Config> {
    const config: Config = {
        remote: 'local',
        remoteRoot: join(dir, 'remote'),
        hostId: 'laptop',
        sources: [
            { agent: 'claude', localPath: join(dir, 'claude'), enabled: true },
            { agent: 'codex', localPath: join(dir, 'codex'), enabled: false },
        ],
    };
    await saveConfig(config, dir);
    return config;
}

// pull the mutagen subcommand chain out of a recorded call list
function mutagenCalls(calls: string[][]): string[][] {
    return calls.filter((c) => c[0] === 'mutagen').map((c) => c.slice(1));
}

// -- start --------------------------------------------------------------------

describe('syncStart', () => {
    // creates a session for each ENABLED source (codex is disabled → skipped)
    it('creates a session per enabled source', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        // exactly one `sync create` (for claude), none for the disabled codex
        const creates = mutagenCalls(runner.calls).filter((c) => c[0] === 'sync' && c[1] === 'create');
        assert.equal(creates.length, 1);
        assert.ok(creates[0].some((a) => a.includes('--name=uc-laptop-claude')));
    });

    // an already-present session is resumed + flushed instead of recreated
    it('resumes an existing session', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Paused\n' });

        await syncStart(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'resume' && c[2] === 'uc-laptop-claude'));
        assert.ok(cmds.some((c) => c[1] === 'flush' && c[2] === 'uc-laptop-claude'));
        assert.ok(!cmds.some((c) => c[1] === 'create'));
    });

    // a missing mutagen binary is a clean error before anything is attempted
    it('errors when mutagen is not installed', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();
        const d: SyncDeps = { ...deps(dir, runner), commandExists: async () => false };

        await assert.rejects(syncStart(d), /mutagen/);
    });
});

// -- stop ---------------------------------------------------------------------

describe('syncStop', () => {
    // pauses every enabled session that currently exists
    it('pauses enabled sessions that exist', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await syncStop(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'pause' && c[2] === 'uc-laptop-claude'));
    });
});

// -- status -------------------------------------------------------------------

describe('syncStatus', () => {
    // returns the parsed SessionInfo[] from `sync list --long`
    it('returns parsed sessions', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const long = `Name: uc-laptop-claude
Alpha:
        URL: /a
        Connected: Yes
Beta:
        URL: /b
        Connected: Yes
Status: Watching for changes
`;
        const runner = fakeRunner({ list: long });

        const sessions = await syncStatus(deps(dir, runner));

        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].name, 'uc-laptop-claude');
        assert.equal(sessions[0].status, 'Watching for changes');
        // it asked for the long form
        assert.ok(mutagenCalls(runner.calls).some((c) => c.includes('--long')));
    });
});

// -- list ---------------------------------------------------------------------

describe('syncList', () => {
    // one entry per configured source, carrying its sync state + endpoint
    it('lists configured sources with state', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        const entries = await syncList(deps(dir, runner));

        const claude = entries.find((e) => e.source === 'claude');
        assert.ok(claude);
        assert.equal(claude.sourceState, 'enabled');
        assert.equal(claude.syncState, 'Watching for changes');

        // codex is configured but disabled and has no session → missing
        const codex = entries.find((e) => e.source === 'codex');
        assert.equal(codex?.sourceState, 'disabled');
        assert.equal(codex?.syncState, 'missing');
    });
});

// -- reset --------------------------------------------------------------------

describe('syncReset', () => {
    // terminates owned sessions, then re-starts enabled ones
    it('terminates owned sessions then restarts', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await syncReset(deps(dir, runner));

        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'terminate' && c[2] === 'uc-laptop-claude'));
    });
});

// -- ignores threading --------------------------------------------------------

describe('syncStart ignores', () => {
    // each `sync create` carries the merged ignore patterns as `--ignore=` args
    it('passes --ignore args from the ignore files', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        // seed a global + per-source ignore file before starting
        await mkdir(join(dir, 'ignores', 'claude'), { recursive: true });
        await writeFile(ignorePath(dir), '# global\n.git/\nnode_modules/\n', 'utf8');
        await writeFile(sourceIgnorePath(dir, 'claude'), 'secrets/\n', 'utf8');
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        const create = mutagenCalls(runner.calls).find((c) => c[0] === 'sync' && c[1] === 'create')!;
        assert.ok(create.includes('--ignore=.git/'));
        assert.ok(create.includes('--ignore=node_modules/'));
        assert.ok(create.includes('--ignore=secrets/'));
    });

    // syncStart seeds the global ignore file with defaults when it is absent
    it('seeds the global ignore file with defaults', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(ignorePath(dir), 'utf8');
        assert.match(raw, /node_modules\//);

        // the seeded defaults now flow through as `--ignore=` args
        const create = mutagenCalls(runner.calls).find((c) => c[0] === 'sync' && c[1] === 'create')!;
        assert.ok(create.includes('--ignore=node_modules/'));
    });
});

// -- source remove ------------------------------------------------------------

describe('sourceRemove', () => {
    // terminates the session (when present) and drops the source from config
    it('terminates the session and removes the source', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await sourceRemove('claude', {}, deps(dir, runner));

        // the session was terminated
        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'terminate' && c[2] === 'uc-laptop-claude'));

        // the source is gone from the persisted config
        const config = await loadConfig(dir);
        assert.equal(config.sources.find((s) => s.agent === 'claude'), undefined);
    });

    // removing an unknown source is a clear error
    it('rejects an unknown source', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await assert.rejects(sourceRemove('nope', {}, deps(dir, runner)), /not found/);
    });

    // purgeRemote deletes the remote dir for a local workspace
    it('deletes the remote dir when purgeRemote is set', async () => {
        const dir = await tempDir();
        const config = await seedLocalConfig(dir);
        const runner = fakeRunner();
        // create the remote source dir so removal has something to delete
        const remoteSourceDir = join(config.remoteRoot, 'workspace', 'laptop', 'claude');
        await mkdir(remoteSourceDir, { recursive: true });

        await sourceRemove('claude', { purgeRemote: true }, deps(dir, runner));

        const { access } = await import('node:fs/promises');
        await assert.rejects(access(remoteSourceDir));
    });

    // without purgeRemote the remote dir is left in place
    it('leaves the remote dir without purgeRemote', async () => {
        const dir = await tempDir();
        const config = await seedLocalConfig(dir);
        const runner = fakeRunner();
        const remoteSourceDir = join(config.remoteRoot, 'workspace', 'laptop', 'claude');
        await mkdir(remoteSourceDir, { recursive: true });

        await sourceRemove('claude', {}, deps(dir, runner));

        const { access } = await import('node:fs/promises');
        await access(remoteSourceDir);
    });
});

// -- source enable / disable --------------------------------------------------

describe('sourceSetEnabled', () => {
    // disabling a source persists the flag and best-effort pauses its session
    it('disables a source and pauses its session', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await sourceSetEnabled('claude', false, deps(dir, runner));

        // the flag is persisted
        const config = await loadConfig(dir);
        assert.equal(config.sources.find((s) => s.agent === 'claude')?.enabled, false);

        // the session was paused (best-effort apply)
        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'pause' && c[2] === 'uc-laptop-claude'));
    });

    // enabling a previously-disabled source starts its session
    it('enables a source and starts its session', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await sourceSetEnabled('codex', true, deps(dir, runner));

        // the flag is persisted
        const config = await loadConfig(dir);
        assert.equal(config.sources.find((s) => s.agent === 'codex')?.enabled, true);

        // a create was attempted for the now-enabled source
        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[0] === 'sync' && c[1] === 'create' && c.some((a) => a.includes('uc-laptop-codex'))));
    });

    // toggling an unknown source is a clear error
    it('rejects an unknown source', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner();

        await assert.rejects(sourceSetEnabled('nope', true, deps(dir, runner)), /not found/);
    });
});

// -- remote-shell safety --------------------------------------------------------

describe('remote shell quoting', () => {
    // a hostile source leaf must stay an inert (quoted) filename on the remote —
    // never a command injection into the ssh rm/mkdir lines
    it('quotes hostile paths in the remote rm and mkdir commands', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            sources: [{ agent: 'evil', localPath: join(dir, 'x; touch pwned'), enabled: true }],
        };
        await saveConfig(config, dir);
        const runner = fakeRunner();

        await sourceRemove('evil', { purgeRemote: true }, deps(dir, runner));

        // the rm target single-quotes the leaf; the `;` lives INSIDE the quotes
        // (only the expanded `$HOME/` prefix is unquoted — never the user input)
        const ssh = runner.calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1));
        const rm = ssh.find((c) => c[1]?.includes('rm -rf'))!;
        assert.ok(rm, 'an ssh rm call was made');
        assert.match(rm[1], /rm -rf \$HOME\/'[^']*x; touch pwned'/);
        assert.doesNotMatch(rm[1], /rm -rf [^$']/);
    });

    // the workspace mkdir line quotes every dir the same way
    it('quotes hostile paths in the remote mkdir', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            sources: [{ agent: 'evil', localPath: join(dir, 'y; id'), enabled: true }],
        };
        await saveConfig(config, dir);
        // local path must exist for startSource to engage
        await mkdir(join(dir, 'y; id'), { recursive: true });
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        const ssh = runner.calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1));
        const mk = ssh.find((c) => c[1]?.includes('mkdir -p'))!;
        assert.ok(mk, 'an ssh mkdir call was made');
        assert.match(mk[1], /'[^']*y; id'/);
    });
});

// -- remote `~` expansion (BUG 1) -----------------------------------------------

// a `~/`-rooted remoteRoot must reach the remote shell as an EXPANDABLE `$HOME/`
// — never a single-quoted literal `'~/...'` (which mutagen's own endpoint string
// DOES expand, so a quoted `~` silently desyncs the sync-root parent).
describe('remote ~ expansion', () => {
    // the mkdir line emits `$HOME/` (unquoted) while the user-controlled leaf stays quoted
    it('expands ~ to $HOME in the remote mkdir, keeping the leaf quoted + inert', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            sources: [{ agent: 'evil', localPath: join(dir, 'z; id'), enabled: true }],
        };
        await saveConfig(config, dir);
        await mkdir(join(dir, 'z; id'), { recursive: true });
        const runner = fakeRunner();

        await syncStart(deps(dir, runner));

        const ssh = runner.calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1));
        const mk = ssh.find((c) => c[1]?.includes('mkdir -p'))!;
        assert.ok(mk, 'an ssh mkdir call was made');

        // `~/` became an expandable `$HOME/...` — never a quoted literal `'~/'`
        assert.match(mk[1], /mkdir -p \$HOME\/'[^']*'/);
        assert.doesNotMatch(mk[1], /'~\//);

        // the hostile leaf is still single-quoted (injection guard holds)
        assert.match(mk[1], /'[^']*z; id'/);
    });

    // the rm line likewise expands `~` while quoting the hostile leaf
    it('expands ~ to $HOME in the remote rm, keeping the leaf quoted + inert', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            sources: [{ agent: 'evil', localPath: join(dir, 'x; rm -rf ~'), enabled: true }],
        };
        await saveConfig(config, dir);
        const runner = fakeRunner();

        await sourceRemove('evil', { purgeRemote: true }, deps(dir, runner));

        const ssh = runner.calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1));
        const rm = ssh.find((c) => c[1]?.includes('rm -rf'))!;
        assert.ok(rm, 'an ssh rm call was made');

        // the rm target expands `~` to `$HOME/` (so it hits the real data dir)
        assert.match(rm[1], /\$HOME\/'[^']*'/);
        assert.doesNotMatch(rm[1], /'~\//);

        // the hostile leaf stays single-quoted — `; rm -rf ~` cannot break out
        assert.match(rm[1], /'[^']*x; rm -rf ~'/);
    });

    // BUG 1 (adversarial): a leaf carrying a LITERAL single-quote must close +
    // re-open the quote via the `'\''` escape — never leave a bare `'` that would
    // break out of the rm target. The leaf also carries a `;` (must stay inert).
    it('escapes a single-quote in the leaf as `\'\\\'\'` (no quote breakout)', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            // leaf = `o'brien'; rm -rf ~` — the last path segment carries the quote
            sources: [{ agent: 'evil', localPath: join(dir, "o'brien'; rm -rf ~"), enabled: true }],
        };
        await saveConfig(config, dir);
        const runner = fakeRunner();

        await sourceRemove('evil', { purgeRemote: true }, deps(dir, runner));

        const ssh = runner.calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1));
        const rm = ssh.find((c) => c[1]?.includes('rm -rf '))!;
        assert.ok(rm, 'an ssh rm call was made');

        // the `~` prefix still expands to $HOME (never a quoted literal `'~/'`)
        assert.match(rm[1], /\$HOME\//);
        assert.doesNotMatch(rm[1], /'~\//);

        // each `'` in the leaf became the literal `'\''` escape — the EXACT inert
        // shape is `'o'\''brien'\''; rm -rf ~'` (close-quote, escaped-quote, reopen)
        assert.ok(rm[1].includes(`'.ultracontext/workspace/laptop/o'\\''brien'\\''; rm -rf ~'`), 'leaf quotes are `\'\\\'\'`-escaped');

        // breakout proof: stripping every `'\''` escape triple from the WHOLE
        // command must leave an EVEN number of bare quotes (balanced open/close) —
        // an odd count would mean a leaf quote escaped the surrounding quoting.
        const bareQuotes = rm[1].replace(/'\\''/g, '').match(/'/g)?.length ?? 0;
        assert.equal(bareQuotes % 2, 0, 'bare quotes stay balanced — no breakout');
        // three quoted targets now: the `[ -e … ]` test, the `rm -rf …`, and the
        // `rmdir …` that prunes the parent host dir only when it is empty
        assert.equal(bareQuotes, 6, 'three surrounding quote-pairs (test + rm + rmdir)');

        // the parent rmdir is $HOME-expanded + quoted (the injection guard applies)
        assert.match(rm[1], /rmdir \$HOME\/'[^']*'/);
        assert.doesNotMatch(rm[1], /rmdir '~\//);
    });
});

// -- ssh session terminate on remove (BUG 5) ------------------------------------

// removing a source over ssh must TERMINATE its live mutagen session — and must
// compute the session name BEFORE dropping the source from config.
describe('sourceRemove ssh terminate', () => {
    // a `sync list` carrying the session name → sourceRemove issues a terminate
    it('terminates the live session for an ssh source before removing it', async () => {
        const dir = await tempDir();
        const config: Config = {
            remote: 'user@hub',
            remoteRoot: '~/.ultracontext',
            hostId: 'laptop',
            sources: [{ agent: 'claude', localPath: join(dir, 'claude'), enabled: true }],
        };
        await saveConfig(config, dir);
        const runner = fakeRunner({ list: 'Name: uc-laptop-claude\nStatus: Watching for changes\n' });

        await sourceRemove('claude', { purgeRemote: true }, deps(dir, runner));

        // the session was terminated by name
        const cmds = mutagenCalls(runner.calls);
        assert.ok(cmds.some((c) => c[1] === 'terminate' && c[2] === 'uc-laptop-claude'));

        // and the source is gone from the persisted config
        const reloaded = await loadConfig(dir);
        assert.equal(reloaded.sources.find((s) => s.agent === 'claude'), undefined);
    });
});

// -- visible create failures (BUG 6) --------------------------------------------

// a failed `mutagen sync create` must surface via deps.warn (it used to be
// silently swallowed, returning ok:true while creating NO session).
describe('startSource visible failures', () => {
    // a create that fails → deps.warn names the source + carries the stderr,
    // and syncStart still resolves (other sources proceed)
    it('warns on a failed create without aborting the start', async () => {
        const dir = await tempDir();
        await seedLocalConfig(dir);
        const runner = fakeRunner({}, { failCreate: 'unable to open synchronization root parent directory' });
        const warnings: string[] = [];

        await syncStart({ ...deps(dir, runner), warn: (m) => warnings.push(m) });

        // a warning was raised naming the source and echoing the mutagen stderr
        assert.ok(warnings.some((w) => w.includes('claude')), 'warning names the failing source');
        assert.ok(
            warnings.some((w) => w.includes('unable to open synchronization root parent directory')),
            'warning echoes the mutagen stderr',
        );
    });
});

// -- migration notice through the orchestration ---------------------------------

describe('migration warn wiring', () => {
    // the toml→json migration notice flows through SyncDeps.warn (never silent)
    it('surfaces the migration notice via deps.warn', async () => {
        const dir = await tempDir();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(dir, 'config.toml'), 'remote = "local"\nremote_root = "~/.ultracontext"\nhost_id = "laptop"\n', 'utf8');
        const runner = fakeRunner();
        const warnings: string[] = [];

        await syncList({ ...deps(dir, runner), warn: (m) => warnings.push(m) });

        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /config\.toml/);
    });
});
