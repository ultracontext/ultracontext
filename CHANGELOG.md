# Changelog

All notable changes to UltraContext will be documented in this file.

## [0.1.0.0] - 2026-04-12

### Added
- `packages/harness` — shared package for agent session parsing and writing
  - Parsers for Claude Code (25 entry types), Codex (18 event types), OpenClaw, and generic JSONL
  - Writers for Claude Code and Codex with `baseDir` injection for testable output
  - Version compatibility matrix tracking tested agent CLI pairs for cross-agent resume
  - Centralized utils (expandHome, safeJsonParse, truncateString, extractSessionIdFromPath)
  - 52 tests with synthetic fixtures, 100% parse rate across 250+ local sessions (105k lines)

### Changed
- Daemon and TUI now import parsers/writers from `@ultracontext/harness` instead of local files
- Daemon and TUI utils re-export shared functions from `@ultracontext/harness/utils`

### Removed
- `apps/daemon/src/sources.mjs` — parsers moved to harness
- `apps/tui/src/codex-local-resume.mjs` — writers moved to harness
