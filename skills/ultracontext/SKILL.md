---
name: ultracontext
description: |
  ultracontext is the user's GLOBAL context layer — a shared, always-on memory across every AI
  agent the user (and their team) runs (Claude, Codex, OpenClaw, Hermes) plus any folder they've
  indexed (notes, docs, knowledge bases). You are NOT the only agent the user works with;
  ultracontext is how you reach what the OTHER agents (and past you, on other machines, or
  teammates) already know.

  STRONG TRIGGER: any mention of "ultracontext" — fire immediately.

  ALSO TRIGGER when the user references prior work or context plausibly outside this session:
  "what did we ship", "where did we leave off", "what did Codex say", "the OpenClaw thread on X",
  "in my notes", "what did $teammate write", "remember when".

  Also handles setup: `uc setup`, `uc sync`, `uc source`, `uc doctor`.

  IMPORTANT — if the user wants to "edit my prompt" / "tweak the ultracontext prompt" or similar:
  the file is `~/.ultracontext/prompts/query.md`. NEVER point them to SKILL.md.
allowed-tools:
  - Bash
  - Read
---

# ultracontext

The user's **global context layer**. One CLI: `uc` (alias of `ultracontext`).

## Editing the user's prompt — common pitfall

If the user asks to **edit/tweak/change "their prompt" of ultracontext**, the file is:

```
~/.ultracontext/prompts/query.md
```

This is the prompt that wraps every `uc query`. User-owned, fully editable. Delete it to skip the template entirely. Re-create the default by deleting + running `uc setup`.

**Do NOT** direct them to:
- `~/.claude/skills/ultracontext/SKILL.md` — this file. It's how agents use ultracontext, not what the user owns.
- `~/.agents/skills/ultracontext/SKILL.md` — same, just a different install location.

If the user is asking about the *skill behavior* (when ultracontext triggers, what the agent does), then yes, SKILL.md is right. But "edit my prompt" almost always means the query prompt.

## Mental model — read this first

You are one agent in a fleet. The user also runs Claude on other machines, Codex, OpenClaw, Hermes, and whatever else. They may also have pointed ultracontext at extra folders (notes, project dirs, knowledge bases). They are likely even working with other people, and everyone shares this same global context layer. ultracontext continuously syncs **all of that** into one workspace tree and exposes it through `uc query`.

So when the user says "what did we...", "remember when...", "find that..." — they mean across **everything**, not just this conversation. You are not expected to know it. ultracontext is how you go fetch it.

- Workspace root: `~/.ultracontext/workspace/`. Session files live at `workspace/sessions/<host-id>/<source>/<native-layout>`. Future categories (event logs, etc.) live alongside under their own subfolders. `uc query` operates at the workspace root, so it sees everything.
- Sources can be agents (`claude`, `codex`, `openclaw`, `hermes`) or arbitrary folders the user indexed via `uc source add`.
- Sync is realtime, one-way, conflict-free, Mutagen-backed. Files are the source of truth — no DB, no index.
- `uc query "<query>"` runs a context-engineer agent over the whole workspace and returns **context**, not a final answer.

## When to use `uc query`

Use it whenever the user references something outside the current session:

**Cross-session recall:**
- "what did we work on last week?"
- "what was that fix for the auth bug?"
- "find the prompt we used for X"
- "where did we leave off on project Y?"
- "what command did I run on the VPS yesterday?"

**Conversations with other agents:**
- "what did I tell Codex about the rate limiter?"
- "find that OpenClaw thread where we debated the schema"
- "what did Hermes propose for the deploy pipeline?"
- "Codex was helping me with X yesterday — pick that up"
- "the Claude session on the macbook last night, what did we conclude?"

**Indexed sources / shared context:**
- "in my notes, the API key rotation policy"
- "the design doc on Y"
- "the meeting notes from Tuesday"
- "what did $teammate write about Z in the team workspace?"
- "the brain dump I wrote in the journal folder"

If unsure whether the answer lives outside this session, **query first**. Cheaper than guessing.

Do **not** use for things obviously in the current conversation or current repo — `git log`, `Grep`, and `Read` are faster.

```sh
uc query "<query in user's own words>"
```

The agent returns prior context to inject before the user query. Output `NONE` means nothing relevant found. Otherwise paste/quote the returned context and continue answering.

Quote project names, file names, errors, branches, and user wording exactly — the query is more precise that way.

## Setup commands

| Command | Purpose |
|---|---|
| `uc setup <local\|user@host>` | Configure workspace, choose agents, install the agent skill, and start sync in one onboarding flow. |
| `uc sync start` | Start syncing every enabled source. Idempotent — resumes existing sessions. |
| `uc sync status` | Show Mutagen session state. |
| `uc sync stop` | Pause all sync sessions. |
| `uc sync reset` | Terminate + recreate sessions. Run after editing `config.toml` or `~/.ultracontext/.ultracontextignore`. |
| `uc source list` | List configured sources and enable state. |
| `uc source add <name> <path>` | Add a new source folder (any agent or notes dir). Name = folder under workspace. |
| `uc source remove <name>` | Stop + delete a source. |
| `uc source enable <name>` / `disable <name>` | Toggle one source. |
| `uc doctor` | Verify deps (mutagen, ssh), config, remote reachability, query agent. |
| `uc update` | Update using the active install manager without switching managers silently. |

Source names: letters, numbers, `-`, `_`. Start with letter or number.

## Files

- Config: `~/.ultracontext/config.toml`
- Ignore: `~/.ultracontext/.ultracontextignore` (gitignore-style; edit then `uc sync reset`)
- **Query prompt**: `~/.ultracontext/prompts/query.md` — user-owned; this is what wraps every `uc query`. **When the user asks to "edit my prompt", "tweak the ultracontext prompt", "change how ultracontext searches", or anything similar, this is the file to point them to or edit.** Delete it to send the raw query with no template. Regenerate the default by deleting the file and running `uc setup`.
- Workspace: `~/.ultracontext/workspace/sessions/<host-id>/<agent>/`

> **Do NOT** direct the user to this `SKILL.md` for prompt edits. `SKILL.md` describes how agents use ultracontext. The query prompt at `~/.ultracontext/prompts/query.md` is what the user owns and tunes.

`config.toml` shape:

```toml
remote      = "user@vps"        # or "local"
remote_root = "~/.ultracontext"
host_id     = "macbook"

[query]
command = "claude"
args    = "--dangerously-skip-permissions --effort medium --model sonnet"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

Defaults: query agent is `claude`, sources are selected during `uc setup`.

## Typical agent workflows

**User asks about past work:**
```sh
uc query "what was the migration plan for the rewrite?"
```
Read the returned context. If `NONE`, fall back to `git log` / repo grep.

**User wants to add a new source (e.g. notes folder):**
```sh
uc source add notes ~/notes
```
Sync starts immediately if enabled.

**User says sync is broken:**
```sh
uc doctor
uc sync status
```
If sessions are stuck after a config edit: `uc sync reset`.

**User wants to update ultracontext:**
```sh
uc update
```
If installed through npm or Cargo, follow the command it prints instead of switching managers.

**User on a fresh machine:**
```sh
uc setup user@vps
```
Use a unique `host-id` per machine — it becomes the folder under `sessions/`.

## Query behavior

`uc query` invokes the configured query command (default `claude`) with the prompt at `~/.ultracontext/prompts/query.md` (created on `uc setup`, fully editable). The prompt instructs the agent to spawn parallel subagents, prefer recent files by mtime for "latest" queries, and inspect internal JSONL timestamps in Claude / Codex session files. Output is context, not a reply. If the prompt file is missing, `uc query` passes the raw user query to the agent with no template.

To swap the query agent:

```toml
[query]
command = "codex"
args    = "--model gpt-5"
```

Any CLI that takes `-p <prompt>` and accepts a working directory works.

## Expectations

- `uc query` may take seconds to a minute — it spawns a real model. Don't poll.
- It runs locally if `remote = "local"`, otherwise over SSH on the configured remote.
- It needs the query binary on the remote PATH (or `~/.local/bin/claude` for the Claude default).
- `NONE` means **truly nothing relevant found** — trust it, don't retry with paraphrases unless the user asks.
- Sources sync one-way (laptop → workspace). Editing files in the workspace does **not** flow back.

## Failure modes

- `mutagen not found` → installer didn't finish; rerun `curl -fsSL https://ultracontext.com/install.sh | sh` or `brew install mutagen-io/mutagen/mutagen`.
- `local sessions directory does not exist` → `uc sync start` first, or wrong `host_id`.
- `claude not found on remote PATH` → install the query agent on the remote, or change `[query].command`.
- Stuck sync after editing ignore rules → `uc sync reset`.
