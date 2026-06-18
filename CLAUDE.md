# [CLAUDE.md](http://CLAUDE.md)

Guidance for Claude Code working in this repo.

## What this is

UltraContext is the context SDK to build AI applications. You get local-first SDKs backed by a single Rust core to manage workspaces, append-only sessions, context windows, workspace artifacts, and file-like agent workflows in a simple way.

Layout: `core/` (Rust engine) · `sdks/js` (JS wrapper + N-API binding) · `sdks/python` (Python wrapper + PyO3 binding) — components at root, languages inside `sdks/`.

## Philosophy (load-bearing for every decision)

1. **Legofy it** — configurable > customizable; user composes blocks.
2. **Just works** — factory defaults are already great; building yourself is optional.
3. **Transparency builds trust** — show everything; plain inspectable formats.
4. **Speed matters.**
5. **Ownership** — the data and the stack are the user's; no vendor lock-in.
6. **Simplicity** — simple beats complex; less beats more.

## Working style

- **Think before coding** — state assumptions; if ambiguous, present options, don't pick silently; push back when simpler path exists.
- **Nothing speculative** — no features, abstractions, or configurability beyond the ask.
- **Surgical changes** — touch only what the task needs; never "improve" adjacent code; remove only orphans your change created.

## Data model — everything is a node

See `core/MODEL.md`.

## SDK rule

Identical surface in every language: same methods, params, shapes, error codes.

## TDD (mandatory)

Every module is RED (failing test first) → GREEN (implement).

## Style

- Rust: rustfmt defaults; one short semantic comment atop each logical block + a blank line between blocks.
- JS wrapper: 4-space indent, single quotes, kebab-case files, ESM.

## Conventions

- **Commits**: Conventional Commits. NEVER add `Co-Authored-By` (hard rule).
