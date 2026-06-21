# MODEL - everything important is a node

UltraContext is a context and artifact store for AI applications. The core
model is not a filesystem and not an object-store wrapper. It is a small node
graph that can be projected into SDK calls, remote HTTP, local
materialization, and an optional native NFS mount.

The database is the source of truth for identity, history, metadata,
provenance, paths, and content references. Small text can live inline in the
database. Large bytes can live in a Rust core content store. Inline, local-dir,
and S3-compatible object stores are implemented today.

```
SDK / HTTP / local materialization / optional native mount
              |
        path projection
              |
        node store
              |
   inline data or storage ref -> blob store
```

Versioning is always represented by `prev`. The node that callers read by
default is the terminal node in the chain.

```
                      ┌──────────────────────┐
                      │ session  ses_4f2e... │  the permanent id - what you hold
                      └──────────────────────┘
                                 ▲
                ┌────────────────┼────────────────┐  owner = session membership
                │                │                │
          ┌──────────┐     ┌──────────┐     ┌──────────┐
          │ ctx   v0 │◄────│ ctx   v1 │◄────│ ctx   v2 │ ◄── CURRENT
          │ {create} │ prev│ {update} │ prev│ {delete} │     (nothing points at it)
          └──────────┘     └──────────┘     └──────────┘
               ▲                ▲                ▲
               │                │                │   owner = context snapshot
          ┌──────────┐     ┌──────────┐     ┌──────────┐
          │  msg_a   │     │  msg_a   │     │  msg_b'  │
          │   "hi"   │     │   "hi"   │     │  "hbu!"  │
          └──────────┘     └──────────┘     └──────────┘
               ▲                ▲
               │ prev           │ prev
          ┌──────────┐     ┌──────────┐
          │  msg_b   │     │  msg_b'  │──── parent -> msg_b
          │  "hbu?"  │     │  "hbu!"  │     ("I came from b")
          └──────────┘     └──────────┘

  v0: created from the session log · v1: patched b -> b' (a keeps its id) ·
  v2: soft-deleted a (b' carries over, same id)

                      ┌──────────────────────┐
                      │ artifact art_brief   │  stable file identity
                      └──────────────────────┘
                                 ▲
                ┌────────────────┼────────────────┐  same artifact id/path membership
                │                │                │
          ┌──────────┐     ┌──────────┐     ┌──────────┐
          │ file  v0 │◄────│ file  v1 │◄────│ file  v2 │ ◄── CURRENT
          │ draft.md │ prev│ draft.md │ prev│ final.md │
          └──────────┘     └──────────┘     └──────────┘
             "# Draft"        "# Draft!"       "# Final"
```

Workspace containment is separate from versioning. A workspace owns sessions
and artifacts; a session owns its log and context snapshots.

```
+-- workspace ws_project --------------------------------------------------+
| owner: null                                                              |
|                                                                          |
| files / artifacts                                                        |
|                                                                          |
|   drafts/brief.md  -> art_brief (HEAD) --prev--> art_brief@v1 --prev--> v0|
|   images/ui.png    -> art_ui    (HEAD) --prev--> art_ui@v0               |
|                                                                          |
| sessions                                                                 |
|                                                                          |
|   +-- session ses_main ------------------------------------------------+ |
|   | owner: ws_project                                                  | |
|   |                                                                    | |
|   | log:      msg_001 <-prev- msg_002 <-prev- msg_003                  | |
|   | contexts: ctx_001 <-prev- ctx_002 <-prev- ctx_003 (HEAD)           | |
|   |                                                                    | |
|   | ctx_003 may reference artifacts:                                   | |
|   |   [{ artifact_id: "art_brief", version: 2 }]                       | |
|   +--------------------------------------------------------------------+ |
|                                                                          |
|   +-- session ses_subagent --------------------------------------------+ |
|   | owner: ws_project                                                  | |
|   | parent: ses_main or triggering msg/tool node                       | |
|   | log/context chains are independent                                 | |
|   +--------------------------------------------------------------------+ |
|                                                                          |
+--------------------------------------------------------------------------+
```

## The Node

```
node {
    public_id   ws_... | ses_... | ctx_... | msg_... | art_... // stable public handle
    kind        'workspace' | 'session' | 'context' | 'message' | 'artifact'
    content     {}                            // domain payload
    metadata    {}                            // caller labels
    prev        -> node before me in a list    // order / version chain
    parent      -> node I came from            // provenance / fork, not containment
    owner       -> node that contains me        // membership / cascade
    created_at  ISO-8601 UTC ms
}
```

There are five core node roles:

| Role | `kind` | `owner` | Meaning |
|---|---|---|---|
| Workspace | `workspace` | `null` | Project/area-of-work namespace |
| Session | `session` | workspace id | Stable run/conversation plus append-only log |
| Context | `context` | session id | One model-facing window snapshot for that session |
| Message | `message` | session id or context id | Session log entry, or projected context-window entry |
| Artifact | `artifact` | workspace id | Versioned file-like object in the workspace |

The model uses three structural pointers with separate meanings:

- `prev` is order. Context snapshots form a context version chain. Session
  messages form an append-only log. Artifact versions form their own chain.
- `owner` is containment. Workspaces own sessions and artifacts. Sessions own
  context snapshots and append-only log messages. Materialized context
  snapshots can own projected message rows.
- `parent` is provenance. It points to the node this node was copied, forked,
  derived, cropped, regenerated, or edited from. `parent` is not used to
  express "this node belongs to this session/workspace".

## Workspaces, Sessions, Contexts, And Messages

A workspace is the project-like namespace for artifacts and future policy/sync
scoping. The default API creates a hidden `ws_default` workspace so simple
users can start with `uc.sessions.create()` and never think about workspaces.

A session is the stable handle for a conversation, run, or agent task. It owns
an append-only log of what happened. Appending a user/assistant/tool message
adds to the session log. Session log entries are not mutated by trimming,
summarization, clearing, restore, or context-window optimization.

A context is one model-facing window for a session. A context can start as
"the whole session so far", then diverge as the app removes entries, clears the
window, restores an older window, or otherwise changes the prompt sent to the
model. Reads choose a context snapshot: latest by default, or an older snapshot
for time travel. Writes never edit an existing context snapshot.

There is no separate "context root" node. The session is the root. The current
context is the terminal `context` node owned by the session in the `prev`
chain. `content.initial_context_id` is a creation-time reference, not the
source of truth for the active window.

The public SDK should expose this as a session-first context surface:
`session.context` is the current model-facing window for that session.
Mutations through `session.context.*` advance the current context while
preserving the durable session log and context revision history. This keeps the
product language centered on context without making a context snapshot the
root identity.

- `append` adds messages to the session log. If the current context already has
  a materialized projected window, the new message is also projected into that
  window without mutating older session messages. In the public SDK this is
  `session.context.append(...)`.
- `update`, soft removal, clearing, and restore create a new context snapshot.
  Old snapshots remain readable. In the public SDK these are
  `session.context.update(...)`, `session.context.remove(...)`,
  `session.context.clear(...)`, and `session.context.restore(...)`.
- `restore` creates a new current snapshot from an older snapshot; it does not
  move the current pointer backward in place.
- `fork` creates a new session in the same workspace and copies the chosen
  context window into the new session log, preserving provenance through
  `parent`.
- A subagent is modeled as another session. If it was spawned by a parent
  session, `parent` can point at that parent session or at the triggering node.

Message content is provider-neutral JSON. A text-only prompt can be a simple
object. A multimodal prompt can reference artifacts:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is wrong with this UI?" },
    { "type": "image", "artifact_id": "art_0123...", "version": 1 }
  ]
}
```

Provider adapters translate this shape into OpenAI, Anthropic, Gemini, or any
other model format. The core does not depend on provider payloads.

## Artifacts

Artifacts are file-like objects in a workspace: markdown drafts, generated
code, screenshots, images, audio, PDFs, zip files, or any other AI
input/output. Contexts and messages reference artifacts; they do not own them.

An artifact node's `content` carries the file-facing metadata:

```json
{
  "path": "drafts/brief.md",
  "kind": "text/markdown",
  "size": 1234,
  "sha256": "...",
  "storage": {
    "type": "inline"
  }
}
```

For larger or binary content:

```json
{
  "path": "uploads/screenshot.png",
  "kind": "image/png",
  "size": 89123,
  "sha256": "...",
  "storage": {
    "type": "ref",
    "driver": "s3",
    "key": "artifacts/art_.../v3"
  }
}
```

`art_` is the identity. `path` is a mutable label used by SDK file verbs,
agent tools, and filesystem projections. This matters:

- editing `draft.md` creates a new version of the same `art_`;
- renaming `draft.md` to `final.md` preserves history;
- editor save dances such as `draft.md.tmp` plus rename can be mapped back to
  a new version of the original artifact;
- two writers racing on the same artifact must produce a conflict or fork,
  never silent data loss.

Artifacts have time travel through their own `prev` chain. This is independent
from session/context time travel. A message can pin `{ artifact_id, version }`
when reproducibility matters, while the workspace path points at the latest
artifact version by default.

Text artifacts usually store data inline. Images and large binaries usually
store bytes in a content store and keep only the `storage` ref in the node.
Either way, versioning and workspace ownership are node-store responsibilities.

## Path Projection

The filesystem-like namespace is a projection over workspace artifacts, not the
storage primitive. Paths are relative POSIX paths inside a workspace:

- normalize `/` separators;
- reject absolute paths and `..`;
- treat directories as prefixes in v2;
- keep path lookup separate from artifact identity.

The same path grammar must be used by SDK calls, local materialization, and
native mounts. The simple API may accept a session/context handle and resolve
its workspace implicitly; advanced APIs can target a workspace directly. A
model can think in `read`, `write`, `grep`, and `glob`; the only difference is
whether the environment exposes those verbs as API calls, a synced directory,
or a mounted filesystem.

## Storage Blocks

The node store and content store are separate blocks.

Node store:

- workspaces, sessions, context windows, messages, artifact metadata;
- local SQLite for local apps, CLIs, and agents;
- remote HTTP for edge runtimes such as Vercel Edge;
- future adapters can sit behind the same contract, but must preserve node
  invariants.

Content store:

- inline database content for small text and markdown;
- local directory for local cache or large local files;
- S3-compatible object storage for S3, R2, MinIO, and shared remote blobs.

The content store can be swapped. The node store remains the source of truth.

## Invariants

- Public ids are stable handles. A caller should not need to know storage
  layout to hold an id.
- Existing rows are immutable outside schema migrations and destructive
  deletes. New versions append nodes.
- Time travel is a read concern: choose an older context snapshot or artifact
  version.
- Destructive session delete is explicit and cascades through session-owned
  contexts/messages. Workspace artifacts are workspace-owned and are not
  deleted merely because one session disappears.
- Blob stores never define existence. A blob without a node is garbage; a node
  with a missing blob is an integrity error.
- Provider-specific prompt shapes stay outside the model.
- File ergonomics are projections over artifacts, not a reason to make the
  core a distributed filesystem.
