# UltraContext

The context SDK for AI applications. It manages workspaces, sessions, context
windows, artifacts, and agent-created files across local and edge/serverless
environments.

> Status: v2 alpha implementation. Core, JS, Python, content stores, shared
> fixtures, package checks, FTS search, snapshot mirror, and the local mount
> adapter are in place. `core/MODEL.md` and `core/CONTRACT.md` are the product
> sources of truth.

## Install

```bash
curl -fsSL https://ultracontext.ai/install | bash
```

The installer installs `uc` and initializes the global store. `uc init` remains
local by default when run manually inside a project.

For project setup without a global install:

```bash
# JavaScript/TypeScript project
npx ultracontext init

# Python project
uvx ultracontext init
# or
pipx run ultracontext init
```

`uc init`, `npx ultracontext init`, `uvx ultracontext init`, and
`pipx run ultracontext init` have the same semantics. The package launchers
only resolve and run the Rust CLI. They create a committed project config and
local runtime state:

```text
ultracontext.json
.ultracontext/
  ultracontext.db
  blobs/
  .gitignore
```

The config is intentionally visible:

```json
{
  "db": ".ultracontext/ultracontext.db",
  "storage": {
    "contentDir": ".ultracontext/blobs",
    "inlineLimit": 65536
  },
  "mount": {
    "defaultScope": "auto"
  }
}
```

If `package.json` exists and `ultracontext` is not already installed, `init`
also installs the JS SDK using the detected package manager (`pnpm`, `bun`,
`yarn`, or `npm`). If `pyproject.toml` or `requirements.txt` exists, it adds
the Python SDK dependency there.

## Examples

Next.js route handler:

```ts
// app/api/ultracontext/[...path]/route.ts
import { createUltraContextNextHandler } from 'ultracontext/next'

export const { GET, POST, PATCH, DELETE } =
  createUltraContextNextHandler({ projectRoot: process.cwd() })
```

Browser client:

```ts
import { createClient } from 'ultracontext'

const uc = createClient('/api/ultracontext')
const session = await uc.create({ metadata: { app: 'demo' } })
await uc.append(session.id, { role: 'user', content: 'Draft a README' })
```

Server/local client:

```ts
import { createServerClient } from 'ultracontext/ssr'

const uc = await createServerClient({ projectRoot: process.cwd() })
```

Artifacts:

```ts
await uc.write(session.id, 'draft.md', '# Draft', { kind: 'text/markdown' })
const draft = await uc.read(session.id, 'draft.md')
```

Local filesystem mount:

```bash
uc init
uc mount ./UltraContext
open ./UltraContext
```

- **Edge-safe** - JS remote mode is fetch-only, so Vercel Edge-style apps do
  not need SQLite, native bindings, or a persistent filesystem. The JS package
  exposes Supabase-style `createClient`, `createBrowserClient`, and
  `createServerClient` helpers through `ultracontext` and `ultracontext/ssr`,
  plus explicit `browser`, `node`, and `server` runtime entrypoints.
- **Self-hostable path** - the JS package includes an official SSR route
  handler, a fetch-compatible HTTP handler, SQLite/Postgres reference engines,
  local-dir blobs, and injected S3-compatible blob storage.
- **Local-first where possible** - local apps, CLIs, and agents can use
  `UltraContext.openProject()` against the project's `ultracontext.json` and a
  plain SQLite node store they own and can inspect.
- **Thin language bindings** - the Rust core exposes a JSON dispatch boundary
  so JS/Python local mode can call the same semantics as remote mode.
- **Workspace artifacts built in** - markdown drafts, images, screenshots, and
  generated files are versioned artifacts, not ad hoc filesystem side effects.
- **Filesystem ergonomics for agents** - artifacts have paths and `uc fs`
  verbs; `uc mount` projects the same workspace namespace into real files.
- **CLI included** - the `uc` binary exposes `uc init`, session/context
  creation, config management, `uc fs`, and `uc mount` for local NFS
  workflows.
- **LEGO blocks** - node store, content store, remote protocol, SDKs, search,
  mirror, and filesystem surfaces are replaceable blocks behind one domain
  model.

## Layout

| Dir | What |
|---|---|
| `core/` | Rust core, model, and product contract |
| `cli/` | `uc` command-line interface and local NFS mount adapter |
| `docs/` | Protocol and implementation notes |
| `sdks/js` | JS/TS SDK, remote edge client, local N-API binding, server engines |
| `sdks/python` | Python SDK, remote client, local PyO3 binding |

## License

Apache-2.0
