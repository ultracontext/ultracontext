# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

UltraContext is the context SDK for AI. You get local-first SDKs backed by a single rust core to manage the context windows of your agents and AI-powered applications.

Layout: `core/` (Rust engine) · `sdks/js` · `sdks/python` — components at root, languages inside `sdks/`. The op contract lives in `core/CONTRACT.md`.

## Philosophy (load-bearing for every decision)

1. **Legofy it** — configurable > customizable; user composes blocks.
2. **Just works** — factory defaults are already great; building yourself is optional.
3. **Transparency builds trust** — show everything; plain inspectable formats.
4. **Speed matters.**
5. **Ownership** — the data and the stack are the user's; no vendor lock-in.
6. **Simplicity** — simple beats complex; less beats more.

## Data model — everything is a node

See `core/MODEL.md`.

## SDK rule

Identical surface in every language: same methods, params, shapes, error codes. Only language idiom differs (JS Promise, Python sync).

## TDD (mandatory)

Every module is RED (failing test first) → GREEN (implement).

## Style

- Rust: rustfmt defaults; one short semantic comment atop each logical block + a blank line between blocks.
- TS wrapper: 4-space indent, single quotes, kebab-case files, ESM.

## Conventions

- **Commits**: Conventional Commits. NEVER add `Co-Authored-By` (hard rule).
- **Branch**: work on `feat/v2`. Do not push, open PRs, or touch `main`.
