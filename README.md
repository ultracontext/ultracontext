<div align="center">
  <a href="https://github.com/ultracontext/ultracontext">
    <img alt="ultracontext: control what agents see" src=".github/assets/context-sdk.png" width="100%">
  </a>
</div>

<div align="center">
  <h1>ultracontext</h1>

  <a href="https://github.com/ultracontext/ultracontext/tree/main/docs"><img alt="Docs" src="https://img.shields.io/badge/DOCS-000000.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.npmjs.com/package/ultracontext"><img alt="NPM version" src="https://img.shields.io/npm/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://pypi.org/project/ultracontext/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/ultracontext/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
</div>

ultracontext is a context SDK for AI. You get SQL-backed storage for sessions, context windows, and artifacts. Everything is auto-versioned, searchable, and mountable as a filesystem, across local, server, and edge. A Rust core with thin JavaScript and Python SDKs.


## Why

Databases and storage weren't built for AI. If we want to keep pushing the boundaries, we have to treat sessions, context windows, and artifacts as first-class citizens, not afterthoughts.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/main/install.sh | bash
```

## Getting started

From your project folder:

```bash
uc init
```

Store a session and build context:

```ts
import { createClient } from 'ultracontext/local'
const uc = createClient()

// Create a session
const session = await uc.sessions.create() // v0

// Append messages (schemaless)
await session.context.append({ role: 'user', content: '...' }) // Still v0
await session.context.append({ role: 'assistant', content: '...' }) // Still v0
```


## Manage context windows

```ts
import { createClient } from 'ultracontext/local'
const uc = createClient()

// Create a session and build context
const session = await uc.sessions.create() // v0
await session.context.append({ role: 'user', content: '...' })
await session.context.append({ role: 'assistant', content: '...' })

// Editing a message auto-creates a new context version (v1)
await session.context.update({ index: 0, content: 'New system prompt' })  // version 1

// Read any past version, or fork a branch from one
const { data } = await session.context.get({ version: 0 })  // the original
const branch = await session.fork({ version: 1 })

// Use with any LLM framework
const response = await generateText({ model, messages: data })
```

## Single source of truth

Since all the context lives on the same place, you query context on demand anywhere you need. For example: Parallel subagents can query each other's context in realtime. append its status to its parent/orchestrator without overhead

```ts
  import { createClient } from 'ultracontext/local'
  const uc = createClient()

  const session = await uc.sessions.get('ses_main')

  // Grab the full context from before compaction — still fully readable.
  const { data: full } = await session.context.get({ version: 7 })

  // Start a clean session and hand it that context for a subagent to investigate.
  const subagent = await uc.sessions.create({ metadata: { parent: session.id } })
  await subagent.context.append([
    ...full,
    { role: 'user', content: 'What caused the regression?' }
  ])
  const finding = await generateText({ model, messages: (await subagent.context.get()).data })
```

## Working with Artifacts

Artifacts are outputs (files, images, code, or markdown, for example) that models creates during a conversation. They are usually saved to external files. Artifacts belong to the workspace, but can associated to a specific session (although not required). Offloading larger context to artifacts is a great strategy to maintain persistence while still keeping models smart with lean context windows.

We recommend mounting your workspace as a filesystem with `uc mount` as agents are great using filesystens (Read ## Portable filesystem)

```ts

// Agent loop start running
const turn = await agent.run()
// Calls tool to write a plan.md to filesystem
// An artifact is automatically created for you (v0).
// Agent finish the first part of the plan
// Plan.md gets updated by the agent
// Everything is auto-versioned (plan.md is now v1)
// Time-travel iterations with .history()


// For AI applications / non agentic loops
import { createClient } from 'ultracontext/local'
const uc = createClient()

const session = await uc.sessions.create()
await session.context.append({ role: 'user', content: 'Generate a plan for the full implementation' })

// Either give tools that models can interact with artifacts (See artifacts API)

// Or create artifact manually after LLM call
const response = await generateText({ model, messages: data })
const artiact = await session.artifacts.create({ '/plans', response })

```

Tip: For AI applications, although can interact with artifacts manually, its better to give the model tools so it can do its job and interact with the artifacts though `session.artifacts.*` with `create`, `update`

## Portable filesystem

UltraContext projects workspace artifacts into a portable filesystem. Agents and editors can work with real files. Changes go back into ultracontext storage auto-versioned for you.

Locally, mount the same workspace as a folder:

```bash
uc mount ./UltraContext
```

In apps or edge, use `session.fs.*` for file verbs like `read`, `write`, `grep`, and
`glob` even when there is no real filesystem. Dive deeper on the [fs API docs](https://todo.docs).


## Search

Full-text search across your sessions and text files, in one query.

Give your agents the CLI:

```bash
uc search "launch notes"
```

Or from the SDK: `uc.search.query('launch notes')` 

You get back snippet plus an id: a message in a context, or a file path. Read the full content with a targeted `session.context` or `session.fs` read.


## License

Apache-2.0
