# API

The public client surface exposed by the SDK.

```ts
uc.workspaces.create({ metadata? })
uc.workspaces.list()

const session = await uc.sessions.create({ workspaceId?, metadata? })
uc.sessions.get(sessionId)
uc.sessions.list()
uc.sessions.delete(sessionId)
uc.sessions.fork(sessionId, { version?, metadata? })

session.context.current({ version? })
session.context.list({ version? })
session.context.append(entry | entry[])
session.context.update(patch | patch[], { metadata? })
session.context.delete(target | target[], { metadata? })
session.context.clear({ metadata? })
session.context.history()
session.context.restore(contextId, { metadata? })

session.artifacts.create({ path, data, kind?, metadata?, ifVersion? })
session.artifacts.list()
session.artifacts.get(pathOrId, { version? })
session.artifacts.update(pathOrId, data, { kind?, metadata?, ifVersion? })
session.artifacts.delete(pathOrId, { ifVersion? })

session.fs.list({ prefix? })
session.fs.read(pathOrId, { version? })
session.fs.write(path, data, { kind?, metadata?, ifVersion? })
session.fs.move(from, to, { ifVersion? })
session.fs.remove(pathOrId, { ifVersion? })
session.fs.glob(pattern)
session.fs.grep(query, { prefix? })

uc.search.query(query)
uc.sync.exportSnapshot()
uc.sync.importSnapshot(snapshot)
uc.sync.exportChanges({ since? })
uc.sync.importChanges(changes)
```
