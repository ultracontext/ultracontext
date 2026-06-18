# Mount Adapters

Mount adapters are the native file surface for local agents. They are exposed
as `uc mount`. They are not the node store, not the content store, and not a
dependency of the Rust core.

By default, the adapter mounts the whole node database as a directory tree:

```
workspaces/
  ws_default/
    drafts/brief.md
    uploads/screenshot.png
  ws_.../
    notes/meeting.md
```

That top-level namespace matters because artifact paths are scoped to a
workspace. Two workspaces can both contain `drafts/brief.md`, so the DB-wide
mount uses `workspaces/<workspace_id>/...` to keep paths unambiguous.

For focused agent workflows, one workspace can also be mounted directly:

```bash
uc --db ./ultracontext.db mount --workspace ws_default ./mnt
```

One session/context handle can also be mounted directly as a
compatibility/convenience path. The adapter resolves that handle's workspace
and projects the workspace files:

```bash
uc --db ./ultracontext.db mount --context ses_... ./mnt
```

In workspace or context mode, the mount root is the artifact tree itself:

```
drafts/brief.md
uploads/screenshot.png
```

Every filesystem operation maps to the same artifact path verbs exposed by the
SDKs:

| Filesystem | UltraContext |
|---|---|
| `readdir` | `list(workspace, { prefix })` or `list(ctx, { prefix })` |
| `read` | `read(workspace, path, { version? })` |
| `write` + `flush` | `write(workspace, path, bytes, { ifVersion })` |
| `rename` | `move(workspace, from, to, { ifVersion })` |
| `unlink` | `remove(workspace, path, { ifVersion })` |
| path glob | `glob(workspace, pattern)` |
| text search | `grep(workspace, query, { prefix? })` |

The node store remains authoritative for identity, history, path labels,
versions, and conflicts. Blob bytes may live inline or in a local directory
through the configured content store.

## Save Semantics

Editors commonly save by writing a temp file and renaming it over the original:

1. write `draft.md.tmp`;
2. flush `draft.md.tmp`;
3. rename `draft.md.tmp` to `draft.md`.

The adapter must collapse that pattern into a new version of the existing
`draft.md` artifact when possible. It should not create a new artifact and
delete the old one unless there is no existing target artifact.

Direct overwrites save a new artifact version. If another writer advances the
artifact at the same time, the adapter surfaces that as a filesystem retry or
I/O error while preserving the underlying `conflict` domain code in logs and
diagnostics.

## Runtime Shape

The NFS adapter is the default `uc mount` backend:

```bash
cargo build -p ultracontext-cli
./target/debug/uc --db ./ultracontext.db mount ./mnt
```

It runs an NFSv3 server bound to `127.0.0.1` on a high local port, then mounts
that export into the requested directory. On macOS this uses `/sbin/mount_nfs`;
on Linux it uses `mount -t nfs`. It does not require macFUSE or a kernel
extension.

NFS mounts run in the background by default. Use `uc unmount` to stop the
server and unmount the directory:

```bash
./target/debug/uc unmount ./mnt
```

For debugging logs in the current terminal, pass `--foreground`:

```bash
./target/debug/uc --db ./ultracontext.db mount ./mnt --foreground
```

The FUSE adapter remains available as an explicit backend behind the optional
`fuse` feature:

```bash
cargo build -p ultracontext-cli --features fuse
./target/debug/uc --db ./ultracontext.db mount --context ses_... ./mnt --backend fuse
```

On macOS, the build host needs macFUSE/osxfuse available to `pkg-config`. On
Linux, the host needs libfuse/fuse3 development files. Without the feature, the
CLI still builds and `uc mount --backend fuse` returns a clear error. FUSE is
currently context-scoped and foreground-only; DB-wide and workspace background
mounts use the default NFS backend.

Both adapters link to the Rust core and call the same operations as JS/Python
local bindings. They should never require S3-FUSE, JuiceFS, or a mounted remote
filesystem underneath.
