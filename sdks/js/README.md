# ultracontext (JS)

UltraContext's JS package has one client API with separate runtime entrypoints:

- `ultracontext`: normal browser/edge-safe remote client. No native imports.
- `ultracontext/ssr`: SSR helpers, with `createBrowserClient` and
  `createServerClient`, plus route/HTTP handlers for server frameworks.
- `ultracontext/next`: Next/App Router route handler alias.
- `ultracontext/server`: server-side exports, including `createServerClient`
  and the fetch-compatible HTTP handler.
- `ultracontext/browser`: explicit browser client alias.
- `ultracontext/node` and `ultracontext/local`: explicit Node local client
  aliases backed by the Rust/N-API core.

Initialize a project:

```sh
npx ultracontext init
```

That writes `ultracontext.json` in the project. Server-side code can open it
without manually resolving db paths, blob directories, inline limits, cwd, or
env overrides.

## Browser / Edge

Use the default package entrypoint in browsers, Vercel Edge, and client bundles:

```js
import { createClient } from 'ultracontext'

const uc = createClient('/api/ultracontext')
```

Use `ultracontext/browser` when you want the runtime boundary to be explicit:

```js
import { createClient } from 'ultracontext/browser'
```

The default client is fetch-only. If you try to use local mode from this
entrypoint, it throws and tells you to import `ultracontext/local`. The client
also binds `globalThis.fetch` internally, so browser-native fetch does not need
a manual wrapper.

## SSR

This mirrors the Supabase split: browser code creates a browser client, server
code creates a server client.

```ts
// lib/ultracontext/client.ts
import { createBrowserClient } from 'ultracontext/ssr'

export function createClient() {
    return createBrowserClient('/api/ultracontext')
}
```

```ts
// lib/ultracontext/server.ts
import { createServerClient } from 'ultracontext/ssr'

export async function createClient() {
    return createServerClient({ projectRoot: process.cwd() })
}
```

`createBrowserClient` always returns the remote fetch client.
`createServerClient` opens the local project by default using
`ultracontext.json`; pass a `baseUrl` or string URL if the server should call a
remote UltraContext endpoint instead.

## Route Handlers

Create `app/api/ultracontext/[...path]/route.ts`:

```ts
import { createUltraContextNextHandler } from 'ultracontext/next'

export const { GET, POST, PATCH, DELETE } =
    createUltraContextNextHandler({ projectRoot: process.cwd() })
```

This server-framework adapter loads `ultracontext.json`, opens the SQLite
store, wires the local content store, and exposes the official UltraContext
HTTP protocol. Apps do not need their own REST translation layer.

## Node Local

Use the local entrypoint in Node apps, CLIs, tests, and agents:

```js
import { UltraContext } from 'ultracontext/local'

const uc = await UltraContext.openProject()
```

Server-side app code can usually prefer the SSR helper:

```js
import { createServerClient } from 'ultracontext/ssr'

const uc = await createServerClient()
```

`ultracontext/node` is the same local entrypoint with a more explicit runtime
name:

```js
import { UltraContext } from 'ultracontext/node'
```

Direct local config is still available when needed:

```js
import { UltraContext } from 'ultracontext/local'

const uc = new UltraContext({
    path: './.ultracontext/ultracontext.db',
    contentDir: './.ultracontext/blobs',
    inlineLimit: 64 * 1024
})
```

## Context Windows

The alpha JS surface is flat and backed by Rust core operations:

```js
const session = await uc.create({ metadata: { app: 'demo' } })
const appended = await uc.append(session.id, { role: 'user', content: 'hi' })

const history = await uc.contextHistory(session.id)
const cleared = await uc.clearContext(session.id, {
    metadata: { reason: 'reset window' }
})
const restored = await uc.restoreContext(session.id, appended.context_id, {
    metadata: { reason: 'time travel' }
})
```

The planned `uc.sessions.*` / `session.context.*` API should remain a thin
wrapper over these same protocol operations.

## Devtools

In browser development, the remote client mounts the local UltraContext modal:

```js
const uc = createClient({
    baseUrl: '/api/ultracontext'
})
```

The modal lists contexts and lets you inspect the current message window. It is
disabled in production unless explicitly enabled with `devtools: true`. Pass
`devtools: false` to disable it in development.

## Lower-Level Server APIs

Self-hosted fetch handler:

```js
import { createUltraContextHandler } from 'ultracontext/server'
import { createSqliteEngine } from 'ultracontext/sqlite'
import { createLocalDirContentStore } from 'ultracontext/content-store'

const handler = createUltraContextHandler({
    engine: createSqliteEngine({
        path: './uc.sqlite',
        contentStore: createLocalDirContentStore({ root: './uc-blobs' }),
        inlineLimit: 64 * 1024
    })
})
```

Postgres + S3-compatible blobs:

```js
import { Pool } from 'pg'
import { createUltraContextHandler } from 'ultracontext/server'
import { createHybridContentStore, createLocalDirContentStore, createS3ContentStore } from 'ultracontext/content-store'
import { createPostgresEngine } from 'ultracontext/postgres'

const remoteStore = createS3ContentStore({
    client: s3CompatibleClient,
    bucket: 'uc-artifacts'
})

const engine = createPostgresEngine({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    contentStore: createHybridContentStore({
        cache: createLocalDirContentStore({ root: './uc-cache' }),
        remote: remoteStore
    }),
    inlineLimit: 64 * 1024
})

await engine.install()

const handler = createUltraContextHandler({ engine })
```

## Bundlers

Do not import `ultracontext/node`, `ultracontext/local`, `ultracontext/sqlite`,
or server-side helpers from `ultracontext/ssr` in browser or edge bundles. Those entrypoints are
server-only and may load Node APIs or the native binding. Browser code should
use `ultracontext` or `ultracontext/browser`.

The local client loads the generated napi-rs entrypoint at
`ultracontext/native/index.js`, then falls back to direct `.node` files. For
Next standalone builds, make sure the package's native files are traced into
the standalone output:

```js
// next.config.js
export default {
    output: 'standalone',
    outputFileTracingIncludes: {
        '/api/ultracontext/**/*': [
            './node_modules/ultracontext/native/**/*',
            './node_modules/ultracontext/ultracontext.*.node'
        ]
    }
}
```

For Electron, keep `ultracontext/node` in the main process or a preload/server
bridge. Renderer code should use `ultracontext/browser` against a local HTTP
route.

## Sync

```js
const snapshot = await source.exportSnapshot()
await mirror.importSnapshot(snapshot)

const changes = await source.exportChanges({ since: snapshot.cursor })
await mirror.importChanges(changes)
```
