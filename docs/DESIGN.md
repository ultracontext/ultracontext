# uc — design (v1)

ultracontext v1 is a **Dropbox for developers and their agents**. It is one Rust binary, `uc`. The binary is the hub, the sync daemon, and the CLI.

- Your folders are the same on every machine, in real time.
- Your Claude Code and Codex sessions follow you. Close the MacBook, open the Linux box, run `uc resume` (or plain `claude -c` in the same project). You continue the same session.
- The hub is the **single source of truth**. Nothing is ever silently lost.

This document is the contract for implementers. Section numbers are referenced from code comments.

---

## 1. Topology

```
                 ┌────────── hub (always-on box) ──────────┐
                 │ uc hub serve                             │
                 │   hub.db   (SQLite WAL: log, entries)    │
                 │   blobs/   (content-addressed, BLAKE3)   │
                 │   logs/    (append-only session logs)    │
                 └──────▲─────────────────────▲────────────┘
     ssh host uc hub connect                  │  (stdio bridge to hub.sock)
                        │                     │
        ┌───────────────┴───┐         ┌───────┴───────────┐
        │ mac: uc daemon     │         │ linux: uc daemon  │
        │  folder spaces     │         │                   │
        │  claude / codex    │         │                   │
        │  client.db         │         │                   │
        └───────▲────────────┘         └───────────────────┘
                │ daemon.sock (control API)
              uc CLI  (you, and your agents)
```

- **Hub**: `uc hub serve` is a long-lived process. It listens on a unix socket `$UC_HOME/hub.sock`. It can also listen on TCP with a token (`--tcp 0.0.0.0:7707`), for LAN and tests.
- **Transport**: clients reach the hub through **SSH**: `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <host> <remote_uc> hub connect`. `uc hub connect` bridges stdio to `hub.sock`. If no hub runs, it starts one (`uc hub serve --detach`). This needs no open ports and no certificates, and works across networks. Your existing SSH keys do the auth.
- **Daemon**: `uc daemon` runs on each machine. It watches the synced folders and agent dirs, and keeps one persistent connection to the hub. It pushes local changes and applies remote changes. It also serves the CLI on `$UC_HOME/daemon.sock`.
- **CLI**: the CLI is a thin client of the daemon. It starts the daemon when it is not running.

Hub address forms (config `hub = "..."`):

| form | meaning |
|---|---|
| `uc`, `user@host`, `ssh://user@host[:port]` | SSH transport (default) |
| `unix:/path/hub.sock` | local unix socket (same machine, tests) |
| `tcp://host:port` | TCP + token (`UC_TOKEN` env or `token =` in config) |
| `local` | = `unix:$UC_HOME/hub.sock`; the daemon starts a hub on this machine if needed |

## 2. Directories and config

`UC_HOME` (default `~/.ultracontext`) holds all state. Tests set `UC_HOME` and `HOME` per process to run many "machines" on one box.

```
$UC_HOME/
  config.toml        client config (§2.1)
  client.db          client state (SQLite)
  daemon.sock daemon.pid  logs/daemon.log
  trash/             every local file uc overwrote or deleted (kept 30 days)
  staging/           temp files for uploads/downloads
  hub/               only on the hub machine
    hub.db  blobs/ab/<hash>  logs/<space>/<path>  hub.sock hub.pid hub.log
```

### 2.1 config.toml

```toml
machine_id   = "m_7f3k2p9q"        # random, generated once
machine_name = "fabios-macbook-pro" # hostname by default
hub          = "uc"                 # see §1
remote_uc    = ""                   # optional explicit path of uc on the hub host
token        = ""                   # tcp only

[sync]
respect_gitignore = true
always_include    = [".env", ".env.*", ".envrc"]   # synced even when gitignored
debounce_ms       = 300

[agents]
claude = true          # root: $CLAUDE_CONFIG_DIR or ~/.claude
codex  = true          # root: $CODEX_HOME or ~/.codex
eager_days = 14        # sessions active in the last N days are materialized eagerly

[[space]]
name = "code"
path = "~/Code"
```

## 3. Data model

### 3.1 Spaces

A **space** is a named synced root. The name is global, and each machine maps it to a local path. The default local path is the home-relative path recorded by the machine that created the space, so `~/Code` on the Mac becomes `~/Code` on Linux. Reserved names start with `@`:

- `@claude`: canonical Claude Code session data (§6)
- `@codex`: canonical Codex session data (§6)

### 3.2 Entries

Every synced thing is an **entry** `(space, path)`. `path` is the canonical relative path: `/` separators, NFC-normalized, never starting with `/`, never containing `..`.

```
kind     file | symlink | log
version  u64   hub sequence number of the last change (global, monotonic)
hash     file/symlink: blake3 hex of content (symlink content = target bytes)
         log: blake3 hex of the last ≤4096 bytes ("tail fingerprint")
size     bytes
exec     bool (file only)
mtime    ms since epoch (as reported by origin; informational + used for materialized mtimes)
deleted  bool (tombstone)
origin   machine_id of the last writer
meta     optional JSON (sessions: §6.3)
owner    machine_id (logs only, §6.4)
```

### 3.3 Hub log

The hub keeps an append-only **change log**. Every accepted mutation gets the next global `seq`. The client cursor is the last seq it applied. The log is the replication stream, the audit trail (`uc log`), and the version history (`uc history`, `uc restore`). Blobs are never deleted in v1.

## 4. Protocol (§4)

### 4.1 Framing

A stream starts with the 8-byte magic `UCPROTO1`, sent by both sides. The reader drops all bytes before the magic, so garbage that shell rc files write to stdout over SSH does no harm. After the magic, every frame is:

```
u32 BE  total_len        (= 4 + json_len + bin_len, max 16 MiB)
u32 BE  json_len
[json_len] bytes JSON    (serde, tagged enum `Msg`)
[rest]     bytes binary attachment (may be empty)
```

### 4.2 Messages

Requests carry `id: u64`. Responses carry `re: u64`. Pushes from the hub carry no `re`. JSON field `t` is the tag.

```
→ Hello      {id, proto:1, machine:{id,name,os,home}, version, token?}
← Welcome    {re, hub_id, head_seq, version}

→ Subscribe  {id, since}             ← Change{...}* (catch-up), CaughtUp{seq}, then live Change pushes
→ HasBlobs   {id, hashes:[..]}       ← Missing{re, hashes:[..]}
→ BlobPut    {id, hash, offset, last:bool} + bin   ← Ok{re}   (hub verifies hash on last chunk; error if mismatch)
→ BlobGet    {id, hash, offset, len} ← Blob{re, hash, offset, eof} + bin
→ Put        {id, space, path, base:Option<u64>, kind:file|symlink, hash, size, exec, mtime, meta?}
             ← Committed{re, seq} | Conflict{re, current:Entry} | Error{re, code, msg}
             base = version this change was made against; None = "I believe it does not exist / is deleted".
             Accepted iff base == current.version (or base==None and entry absent/deleted). Hub must already have the blob.
→ Delete     {id, space, path, base:u64}  ← Committed | Conflict
→ Append     {id, space, path, offset, tail:Option<String>, meta?, claim:bool} + bin(lines)
             ← Committed{re, seq, len} | Conflict{re, current:Entry}
             Accepted iff offset == current.size AND tail matches current tail fingerprint
             AND ownership allows (§6.4). Creates the log if offset==0 and absent.
→ LogReset   {id, space, path, base:u64, hash, size, meta?}  (rewrite a log from a blob; owner only)
→ LogRead    {id, space, path, offset, len} ← Blob{...} + bin
→ Claim      {id, space, path, force:bool} ← Committed{seq} | Busy{re, owner, owner_name, idle_ms}
→ Query      {id, q: Sessions{...} | Log{space?,path?,since?,limit} | History{space,path} | Entry{space,path} | Spaces | Machines | Status}
             ← Result{re, data: JSON}
→ SpaceCreate {id, name, default_path}  ← Committed
← Change     {seq, space, path, kind, op: put|delete|append|reset|claim, version, hash, size, exec, mtime,
              origin, at, offset?, len?, meta?, owner?}  + bin (append data inline when ≤ 1 MiB)
← Error      {re?, code, msg}
→ Ping/Pong  keepalive every 15s; either side drops the connection after 45s of silence.
```

## 5. Sync engine for folders (§5)

### 5.1 Three states per path

For each `(space, path)` the client compares three states:

- **L**: local state. Fingerprint `(size, mtime_ns, inode, exec)` and a hash, computed lazily.
- **B**: base. The last state both this client and the hub agreed on (`base_version`, `base_hash`, local fingerprint at that time).
- **R**: remote state. The hub entry, from the change stream.

| L vs B | R vs B | action |
|---|---|---|
| same | same | nothing |
| changed | same | **push** `Put/Delete` with `base = B.version` |
| same | changed | **apply** R (atomic write / delete-to-trash) |
| changed | changed | if `hash(L) == R.hash`, adopt R as the new base (**no duplicate**); else **conflict** (§5.4) |

The engine is **level-triggered**. Watcher events and remote pushes only mark paths dirty. A periodic full rescan (every 5 min, at startup, and after wake/reconnect) catches anything the watcher missed. Correctness never depends on the watcher.

### 5.2 Reading files that agents are writing (stable read)

1. Push a path only after it has been quiet for `debounce_ms` (300 ms). A path that keeps changing for more than 5 s is pushed anyway, using a stable snapshot.
2. To snapshot: `stat`, then copy into `staging/` while hashing, then `stat` again. If size, mtime, or inode changed, retry with backoff. Upload from the staged copy, never from the live file.

### 5.3 Applying remote changes (atomic, never clobber)

1. Download the blob to `<dir>/.uc-tmp-<rand>` (same filesystem), `fsync`, and set the exec bit and mtime.
2. **Re-check** the target just before the rename. Its fingerprint must still equal B (or the target must still be absent). If it changed, abort and treat the path as a conflict (§5.4).
3. Copy the old content to `trash/` (only if it was never synced), then `rename(tmp, target)`.
4. Record the new base fingerprint (stat after rename). The watcher echo then matches B and is ignored, so no feedback loop is possible.

Remote deletes move the local file to `trash/`, and only if L == B. A remote delete never destroys a local modification: the modification wins and is pushed again as a create.

### 5.4 Conflicts: the hub wins, and nothing is lost

When L and R both changed and their contents differ:

- R takes the canonical path, because the hub is the source of truth.
- L is renamed to `<name>.conflict-<machine>-<YYYYMMDD-HHMMSS>` in the same directory and pushed as a new file, so every machine sees it. The suffix goes after the whole name, so a copy never matches language globs (`*.rs`, `test_*.py`) and never breaks a build.
- `uc conflicts` lists the conflict copies.

The other cases:

- **Same content on both sides**: no conflict.
- **Delete vs modify**: the modification wins.

Inside `.git/` the same rule applies. A losing ref becomes a valid ref next to it, e.g. `refs/heads/main.conflict-mac-20261025-141502`, so `git log main.conflict-mac-…` shows the commits it pointed to.

### 5.5 Ignore rules

These rules apply in order:

1. **Built-in ignores**:
   - OS and editor junk: `.DS_Store`, `Thumbs.db`, `.uc-tmp-*`, `*.swp`, `*.swo`, `*~`, `.#*`
   - Dependency and build dirs: `node_modules/`, `target/`, `.venv/`, `venv/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.next/`, `.turbo/`, `.parcel-cache/`, `.gradle/`, `.terraform/`
   - Volatile git files: `.git/**/*.lock`, `.git/gc.pid`, `.git/fsmonitor--daemon/`, `.git/objects/pack/tmp_*`, `.git/objects/*/tmp_obj_*`
2. `.ucignore` files, in gitignore syntax and hierarchical.
3. `.gitignore`, when `respect_gitignore` is set. Uses the `ignore` crate semantics.
4. `always_include` patterns override rules 2 and 3 (default: `.env`, `.env.*`, `.envrc`). They do not override rule 1.

`.git/` itself is synced. When a batch is pushed, `.git/objects/**` goes first, then the working tree, then `.git/refs/**`, `packed-refs`, `HEAD`, and `index` last. This way a remote never sees a ref that points to an object it does not have yet.

### 5.6 Filesystem semantics

- **Paths**: NFC in canonical form.
- **Case**: on case-insensitive filesystems (probed at the space root), a remote path that collides case-insensitively with a different existing entry is not applied. `uc status` reports it, and no delete is pushed for it.
- **Symlinks**: synced as symlinks. The target is stored verbatim. Symlinks are never followed.
- **Permissions**: only the exec bit. Empty directories are not synced.
- **Special files** (fifos, sockets, devices): ignored.

### 5.7 Guards against silent loss

- **Mass deletes**: when more than half of a space's tracked files (and at least 10) vanish in one rescan, uc pushes no deletes for that space. An emptied, replaced or unmounted folder looks exactly like a mass delete. Deletes resume when the files come back, or when the user confirms with `touch <space>/.uc-allow-deletes`.
- **Hub rollback**: the client remembers the change at its cursor. If the hub restarts without that change (restored from an older backup or a VM snapshot), the daemon stops syncing and leaves a marker until `uc init` re-joins. Re-joining turns differing files into pushes or conflict copies, never overwrites.
- **Case**: on case-insensitive filesystems, every path component must match exactly. A remote path whose folder exists here only under another case is reported as a collision and not applied.
- **Symlinks**: hub paths must be canonical, and writes never pass through a symlinked or non-directory parent (`paths::safe_join`).

## 6. Agent sessions (§6)

### 6.1 Principle: one session, one canonical log

Sessions are keyed by **session id**, not by machine or directory. The hub stores each session exactly once: `@claude/sessions/<id>.jsonl`, `@codex/sessions/<id>.jsonl`. The **driver** for each agent maps between the canonical path and the agent's native on-disk location on this machine. This removes duplicates by construction. A session continued on another machine is the same session, the same id, and the same file.

### 6.2 Logs, not files

Transcripts are append-only JSONL. They replicate as **logs**: the owner appends complete lines (up to the last `\n`), and followers append the same lines. Real time and cheap: only new lines travel. Every line passes through the driver's transforms:

- `clean(line)`, local → canonical: replaces this machine's absolute roots with tokens
- `smudge(line)`, canonical → local: replaces tokens with this machine's roots

Path map tokens:

| token | local value |
|---|---|
| `@@UC_SPACE:<name>@@` | local path of space `<name>` (longest match first) |
| `@@UC_HOME@@` | `$HOME` |

A replacement only happens at a path boundary: the next char must not be alphanumeric, `-`, `_`, or `.`. So `/Users/fabioroma` on the Mac becomes `/home/fabio` on Linux. The resumed agent then sees paths that exist on the new machine. Drivers may opt out and replicate byte-exact; Codex does (§6.5a).

The client tracks a sync point per log: `(local_len, canon_len, local_tail_fp)`. When local bytes past `local_len` grow, the new lines are cleaned and appended. Remote appends are smudged and appended locally. If the local prefix changes (the file shrank or was rewritten), the owner sends `LogReset` with the full cleaned content.

Non-log files of a session (sidecars such as subagent transcripts, tool results, file-history backups) follow the driver's classification: they are logs if append-only JSONL, otherwise files.

### 6.3 Session metadata

The driver parses session metadata from the transcript and sends it as `meta` with each append. The hub stores the latest value.

```json
{"session": {"agent":"claude","id":"…","cwd":"@@UC_SPACE:code@@/proj","title":"…","first_prompt":"…",
             "created_at":…, "updated_at":…, "git_branch":"…", "model":"…", "native_rel":"…"}}
```

### 6.4 Single writer: ownership, takeover, forks

Each log has an **owner** (machine id). It becomes `idle` when the owner has not appended for `lease_idle_ms` (120 s).

An append from machine M is accepted when all of these hold:

- the offset and tail match
- one of:
  - owner is M
  - owner is unset
  - the owner is idle
  - the append has `claim:true` and the session was explicitly claimed by M

Acceptance sets owner = M.

`uc resume` sends `Claim{force}`:

- If another machine owns the session and is not idle, the hub answers `Busy{owner_name, idle_ms}`.
- The CLI then asks: **take over**, **fork**, or **cancel**. Non-TTY callers must pass `--takeover` or `--fork`.

**Divergence never corrupts the canonical log.** If machine A appends lines the hub rejects (A lost ownership, or the hub moved on), A **forks**:

1. Mint a new session id.
2. Build `canonical_prefix[..sync_point] + A's unsynced lines`, with the session id rewritten by `driver.fork_line`.
3. Push it as a new session with `meta.session.forked_from = <id>`.

A leaves its local original alone while it is still hot (changed in the last 60 s; the agent process may still be writing). Once it is cold, A moves it to `trash/` and re-materializes the canonical version. Later stray lines from the old process go to the same fork.

### 6.5 Materialization

On each machine, the daemon materializes a session into the agent's native location when either:

- the session was active in the last `eager_days`, or
- `uc resume` asks for it.

The file mtime is set to the session's last activity. That way `claude --continue` in a project picks the most recently active session from **any** machine.

### 6.5a Agent facts the drivers rely on (verified on Claude Code 2.1.310, Codex 0.162.1)

**Claude Code**

- **Location**: transcript at `projects/<slug>/<id>.jsonl`.
  - The slug is the cwd with every UTF-16 unit outside `[A-Za-z0-9]` replaced by `-`.
  - If the slug is longer than 200 chars: `slug[..200] + "-" + base36(|javaHash(cwd)|)`.
- **Resume**: `claude --resume <id>` works from any directory, but only if the id exists in exactly **one** slug dir. So a machine never holds two copies, and a relocated session is moved, not copied. The resumed session keeps writing to the same file.
- **Continue**: `claude --continue` picks the newest file by mtime in the current slug dir. So materialized files get `mtime = last activity`.
- **Writes**: one `appendFile` per flushed chunk, with no long-lived file handle. A session is live when `sessions/<pid>.json` names it and the pid is alive.
- **Rewrites**: tombstone truncation and optional GC rewrite the file. The owner sends `LogReset` for these.
- **Path rewriting is safe**: resume walks the `uuid`/`parentUuid` tree, not byte offsets.
- **Sidecars** under `<id>/` are synced:
  - `subagents/*.jsonl` (as logs)
  - `subagents/*.meta.json`, `tool-results/*`, `session-memory/*`, `file-history/<id>/*` (as files)

**Codex**

- **Location**: rollout at `sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl`, at the same relative path on every machine.
- **Resume**: `codex resume <id>` finds a rollout from the file alone (filename walk, then DB repair). The state DBs are never synced, because they hold absolute paths.
- **Writes**: one long-lived `O_APPEND` file handle, possibly held by a shared app-server. A writer is live when `thread-writer-locks/<id>.lock` is locked. Never rename over a live rollout.
- **Byte offsets are load-bearing** (fork `history_base`, projections). So Codex lines replicate **byte-exact**: the driver's clean/smudge are identity. The cwd moves through `codex resume -C <local cwd> <id>` instead.
- **Not synced in v1**: `.jsonl.zst` (compressed, more than 7 days old) and revert files (`…_<rollout>.jsonl`).

**Both agents**

- **Local deletes in agent spaces are never propagated.** Agents prune their own files: Claude has 30-day retention, and Codex compresses and archives. Such a prune is not a user's intent to delete the session everywhere.

### 6.6 Drivers

Driver contract (Rust trait `AgentDriver`, `src/drivers/mod.rs`):

- `root()`: native dir (`~/.claude`, `~/.codex`, with env overrides)
- `classify(rel_native_path)`: `None` (not synced, e.g. secrets/caches), or `Some(AgentFile{canonical, session_id, kind})`
- `native_path(canonical, meta, pathmap)`: where the file lives on this machine
- `parse_meta(head_lines)`: session metadata
- `clean_line` / `smudge_line`: path transforms (§6.2)
- `fork_line(line, old_id, new_id)`, `fork_native_path`
- `resume_command(meta, local_cwd)`: the argv to continue the session

Never synced: credentials (`.credentials.json`, `auth.json`), global config and state files, caches, logs, sqlite DBs, telemetry, IDE locks, shell snapshots.

## 7. CLI (§7)

Every command takes `--json`, which prints machine-readable output for agents. Human output is short and colored when stdout is a TTY. Exit codes: 0 ok, 1 error, 2 usage error, 3 conflict/busy (resume).

```
uc init [HUB] [--name NAME] [--yes]   set up this machine; joins all hub spaces at default paths (--yes)
uc add <DIR> [--name NAME]            sync a folder (new space), or map an existing hub space: uc add ~/x --name code
uc rm <NAME>                          stop syncing a space here (local files are kept)
uc spaces                             spaces on the hub and where they live here
uc status                             hub link, machine, spaces, pending up/down, conflicts, live sessions
uc sync [--timeout S]                 rescan now and wait until everything is pushed and pulled ("safe to close the lid")
uc sessions [QUERY] [--agent A] [--machine M] [--here] [--limit N]   all sessions, every machine, newest first
uc resume [ID|QUERY] [--takeover|--fork] [--print] [--agent A]       pull + claim + exec claude/codex in the right dir
uc log [PATH] [--since 1h] [--limit N]   recent changes: who changed what, where
uc history <PATH>                     versions of a file
uc restore <PATH> [--seq N]           restore an old version (as a new change)
uc conflicts                          conflict copies
uc doctor                             checks: hub reachable, versions, watcher limits, clock skew, disk
uc daemon run|start|stop|status       the sync daemon (start = detached)
uc service install|uninstall [--hub]  launchd (macOS) / systemd --user (Linux) autostart
uc hub serve [--tcp ADDR] [--detach]  run the hub
uc hub connect                        stdio bridge (used over ssh)
```

`uc resume` with no argument picks the most recently active session of the current project. With no project, it picks the most recent session overall.

## 8. Non-goals for v1

The following are out of scope for v1:

- end-to-end encryption
- multiple users or sharing
- web UI
- Windows
- content-defined chunking or delta transfer of large files (whole-file blobs; logs already send only appended lines)
- blob garbage collection
