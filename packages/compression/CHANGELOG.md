# Changelog

## 0.1.0

Initial release.

### Features

- **Lossless context compression** — compress/uncompress round-trip restores byte-identical originals
- **Code-aware classification** — fences, SQL, JSON, API keys, URLs, file paths stay verbatim
- **Paragraph-aware sentence scoring** — deterministic summarizer picks highest-signal sentences
- **Code-split messages** — prose compressed, code fences preserved inline
- **Exact dedup** — hash-based duplicate detection replaces earlier copies with compact references (on by default)
- **Fuzzy dedup** — line-level Jaccard similarity catches near-duplicate content (opt-in)
- **LLM summarizer** — `createSummarizer` and `createEscalatingSummarizer` for pluggable LLM-powered compression
- **Token budget** — `tokenBudget` option binary-searches recency window to fit a target token count
- **Verbatim store** — originals keyed by ID for lossless retrieval via `uncompress()`

### API

- `compress(messages, options?)` — sync or async depending on whether `summarizer` is provided
- `uncompress(messages, verbatim)` — restore originals from compressed messages + verbatim map
- `createSummarizer(callLlm)` — wrap an LLM call with an optimized summarization prompt
- `createEscalatingSummarizer(callLlm)` — three-level summarizer (normal → aggressive → deterministic)
