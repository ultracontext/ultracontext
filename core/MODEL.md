# MODEL — everything is a node

The whole engine is one table and two pointers. If you understand this page,
you understand UltraContext.

## The node

```
node {
    public_id   ctx_… | msg_…     // 24 lowercase hex chars after the prefix
    type        'context' | 'message'
    content     {}                 // free-form JSON — yours
    metadata    {}                 // free-form JSON — yours
    prev_id     →  the node before me        (order)
    parent_id   →  the node I came from      (history)
    context_id  →  which chain I belong to   (membership)
    created_at  ISO-8601 UTC
}
```

Three kinds of node, distinguished by two fields:

| Kind | `type` | `context_id` |
|---|---|---|
| **Root** — the context's permanent identity | `context` | `null` |
| **Head** — one version of that context | `context` | root's id |
| **Message** — one entry in a version | `message` | head's id |

## The two pointers

**`prev_id` is order.** Messages in a version form a singly-linked list:

```
null ← msg_a ← msg_b ← msg_c
```

Reading a context = find the chain start (`prev_id = null`), follow the links.
No position numbers stored — `index` is computed while walking.

**`parent_id` is history.** Every write op creates a NEW head; heads chain
through time:

```
root (ctx_…)                          ← the id you hold, never changes
 └─ head v0 {operation: create}
     └─ head v1 {operation: update, affected: [msg_b]}
         └─ head v2 {operation: delete, affected: [msg_a]}   ← current
```

Each head points at its own message list. Old heads keep pointing at the old
lists. Nothing is ever mutated — writes only append.

## Everything falls out of the two pointers

- **Version** = a head. The version log = walking the head chain
  (`getVersions`: index 0 = create, ascending).
- **Time-travel** = read from an older head: `get(id, {version: 1})`,
  `{at: index}`, `{before: timestamp}`.
- **Fork** = a new root whose `parent_id` points at the source root, with the
  chosen version's messages copied under its first head (each copy's
  `parent_id` = the source message — provenance survives).
- **Soft delete** = just another version: a new head without the deleted
  messages. Recover by reading the previous head. No tombstones, no flags.
- **Update** = copy-on-write: a new head where the patched message is a new
  node (`parent_id` = the original message).

## The one destructive op

`delete({permanent: true})` is the only thing that ever removes rows: the
root, every head, every message — scrubbed from all versions. Forks of the
deleted context survive, orphaned (`parent_id` cleared to `null`). That's why
the flag is explicit and the default delete is the versioned one: destruction
is opt-in, always.

## Invariants (port these exactly)

- A root never changes: id, metadata, and `created_at` are set at create and
  list/get read them from the root, not the head.
- One write op = one new head = one version bump — appending an array of
  messages is ONE version.
- Head selection: the head no other node points at; ties broken by newest
  `created_at`.
- Broken chain (can't walk all nodes from `null`): fall back to `created_at`
  ascending, log loudly, never drop nodes, never error.
- Heads' `metadata` carries the reserved keys `operation` + `affected`; user
  version-metadata lives alongside them and is returned without the reserved
  keys.

## Why this model

One concept instead of five tables. Append-only, so history is free instead
of being a feature. The file stays plain SQLite — open it, walk the pointers
yourself, audit everything. It's git for context: a content log + cheap
pointers.
