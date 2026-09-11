<div align="center">
  <h1>UltraContext</h1>
  <h3>Context that goes beyond.</h3>
  <p>Agents, sessions, machines, teams. Anything.</p>
</div>

---

UltraContext is an open-source context toolkit for AI agents. A small kernel captures the context of every agent on all your machines and keeps each version. The tools let any agent search, resume, and fork that context from anywhere.

> **Status:** this branch holds the specification only. The code comes next.

## The problem

Agents lose context.

- An agent compacts its window and loses the plan.
- A new session starts with no context.
- Codex does not know what Claude Code did.
- Your laptop does not know what your server did.

Each agent keeps its own context. That context stops when the agent stops. UltraContext keeps the context after the agent stops.

## How it works

UltraContext has two parts.

**The kernel** captures context from each source and stores it in one tree. It stores the raw data first. It makes a new version on each change. It does not delete old versions. It syncs the tree between your machines.

**The tools** read the tree. There are three tools: search, resume, and fork. You use them from the terminal. Agents use them through the skill, the MCP server, or the SDK.

## One tree

All context lives in one tree. The path tells you where the context came from.

```text
~/.ultracontext/
  <host>/
    <agent>/
      <session>/
        v0
        v1
        v2   <- current
```

- A **host** is a machine.
- An **agent** is a tool such as Claude Code or Codex.
- A **session** is one run of one agent.
- A **version** is the state of one session at one point in time.

## Install

```sh
curl -fsSL https://ultracontext.com/install.sh | sh
uc init
```

`uc init` finds the sources on this machine, starts capture, and installs the skill into each agent.

## Search

Find context in all sessions on all hosts.

```sh
uc search "deploy uses Fly.io"
```

Each result shows the host, the agent, the session, the version, and a short extract.

## Resume

Continue a session in any agent, from any version.

```sh
uc resume ses_4f2e                 # the current version
uc resume ses_4f2e --version 7     # the version before the agent compacted it
uc resume ses_4f2e --into codex    # open it in a different agent
```

## Fork

Start a new session from a point in an old session.

```sh
uc fork ses_4f2e --version 7
```

The new session gets a new id. The old session does not change.

## Sources

A source is anything that makes context. There are three kinds.

| Kind | Example | How the kernel gets the context |
| --- | --- | --- |
| Directory | `~/.claude`, `~/.codex`, `~/.cursor` | It watches the directory and copies new files. |
| Stream | A hosted agent, an API | It polls the endpoint or receives events. |
| Push | Your own agent, through the SDK | Your code writes to the tree. |

Add a source with one command.

```sh
uc source add notes ~/notes
```

## SDK

Use the SDK to make your own agent a source. Its sessions go into the same tree as all other sessions.

```ts
import { UltraContext } from 'ultracontext'

const uc = new UltraContext()
const session = await uc.sessions.create()
await session.append({ role: 'user', content: 'Deploy uses Fly.io.' })

const { data } = await session.get()
const response = await generateText({ model, messages: data })
```

The SDK has the same three tools: `uc.search`, `uc.resume`, and `uc.fork`.

## Rules

Four rules apply to all parts of UltraContext.

1. **Raw data is the truth.** The kernel stores the source data as it is. Parsers run later. A parser error does not lose data.
2. **Each change makes a version.** The kernel does not overwrite data.
3. **All context is a file.** You can read the tree with `ls`, `cat`, and `grep`. Agents can do the same.
4. **The tools are small.** Each tool does one job. Each tool can write JSON. You can connect tools with pipes.

## License

Apache-2.0
