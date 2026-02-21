<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/og-node.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">Context compression engine</h3>

<p align="center">
  <a href="https://ultracontext.ai/docs">Documentation</a>
  ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a>
  ·
  <a href="https://github.com/ultracontext/ultracontext/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ultracontext/ultracontext" alt="license" />
  </a>
</p>

<br />

`@ultracontext/compression` is the standalone compression engine that powers `uc.compress()`. Use it directly when you want client-side compression without the UltraContext API, or plug in your own LLM for higher-quality summaries.

Zero dependencies. Works in Node, Deno, Bun, and edge runtimes.

<br />

## Why

Context is the RAM of LLMs. As it grows, model attention spreads thin (**context rot**). Compression keeps the signal-to-noise ratio high by summarizing prose while preserving code, structured data, and technical content verbatim.

- **Lossless round-trip** — `compress` then `uncompress` restores byte-identical originals
- **Code-aware** — Fences, SQL, JSON, API keys, URLs, and file paths stay verbatim
- **LLM-powered** — Plug in any summarizer (Claude, GPT, Ollama, etc.) for higher-quality summaries
- **Budget-driven** — `tokenBudget` option automatically finds the right compression level
- **Zero dependencies** — Pure TypeScript, no crypto, no network calls

<br />

## Install

```bash
npm install @ultracontext/compression
```

<br />

## Quick Start

```ts
import { compress, uncompress } from '@ultracontext/compression';

// compress — prose gets summarized, code stays verbatim
const { messages, verbatim, compression } = compress(messages, {
  preserve: ['system'],  // roles to never compress
  recencyWindow: 4,      // protect the last N messages
});

// uncompress — restore originals from the verbatim store
const { messages: originals } = uncompress(messages, verbatim);
```

**Important:** `messages` and `verbatim` must be persisted together atomically. Writing compressed messages without their verbatim originals causes irrecoverable data loss.

<br />

## API

### compress

Deterministic compression by default. Returns a `Promise` when a `summarizer` is provided.

```ts
import { compress } from '@ultracontext/compression';

// Sync — no summarizer
const result = compress(messages, {
  preserve: ['system'],
  recencyWindow: 4,
  sourceVersion: 1,
});

// Async — with LLM summarizer
const result = await compress(messages, {
  summarizer: async (text) => {
    return await myLlm.summarize(text);
  },
});

result.messages;                        // compressed message array
result.verbatim;                        // original messages keyed by ID
result.compression.ratio;               // char compression ratio (>1 = savings)
result.compression.token_ratio;         // token compression ratio (>1 = savings)
result.compression.messages_compressed; // how many were compressed
result.compression.messages_preserved;  // how many were kept as-is
```

| Option | Type | Default | Description |
|---|---|---|---|
| `preserve` | `string[]` | `['system']` | Roles to never compress |
| `recencyWindow` | `number` | `4` | Protect the last N messages from compression |
| `sourceVersion` | `number` | `0` | Version tag for provenance tracking |
| `summarizer` | `Summarizer` | — | LLM-powered summarizer. When provided, `compress()` returns a `Promise` |
| `tokenBudget` | `number` | — | Target token count. When set, binary-searches `recencyWindow` to fit |
| `minRecencyWindow` | `number` | `0` | Floor for `recencyWindow` when using `tokenBudget` |

#### Summarizer fallback

When a `summarizer` is provided, each message goes through a three-level fallback:

1. **LLM summarizer** — uses the result if it is non-empty **and** strictly shorter than the input
2. **Deterministic** — sentence extraction + entity preservation (if the LLM threw, returned empty, or returned equal/longer text)
3. **Size guard** — preserves original verbatim if even deterministic compression would increase size

#### Token budget

Use `tokenBudget` to automatically find the least compression needed to fit a token limit. The engine binary-searches `recencyWindow` internally.

```ts
const result = compress(messages, {
  tokenBudget: 4000,
  minRecencyWindow: 2,
});

result.fits;       // true if result fits within budget
result.tokenCount; // estimated token count

// With LLM summarizer for tighter fits
const result = await compress(messages, {
  tokenBudget: 4000,
  summarizer: mySummarizer,
});
```

### uncompress

Restore originals from the verbatim store. Always sync. Supports recursive expansion for multi-layer compression (up to 10 levels deep).

The second argument accepts either a plain `VerbatimMap` object or a lookup function `(id: string) => Message | undefined` — useful when verbatim data lives in a database rather than in-memory.

```ts
import { uncompress } from '@ultracontext/compression';

const { messages, missing_ids } = uncompress(compressed, verbatim);

// recursive — follows chains of compressed-then-recompressed messages
const deep = uncompress(compressed, verbatim, { recursive: true });

// function store — look up originals from a database
const result = uncompress(compressed, (id) => db.getMessageById(id));

// missing_ids.length > 0 means data loss (partial write)
```

### createSummarizer

Create an LLM-powered summarizer with an optimized prompt template.

```ts
import { createSummarizer, compress } from '@ultracontext/compression';

const summarizer = createSummarizer(
  async (prompt) => {
    return await myLlm.complete(prompt);
  },
  { maxResponseTokens: 300 },
);

const result = await compress(messages, { summarizer });
```

The prompt preserves code references, file paths, function/variable names, URLs, API keys, error messages, numbers, and technical decisions — stripping only filler and redundant explanations.

For domain-specific compression, use `systemPrompt` to inject context:

```ts
const summarizer = createSummarizer(callLlm, {
  systemPrompt: 'This is a legal contract. Preserve all clause numbers, party names, and defined terms.',
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxResponseTokens` | `number` | `300` | Hint for maximum tokens in the LLM response |
| `systemPrompt` | `string` | — | Domain-specific instructions prepended to the built-in rules |
| `mode` | `'normal' \| 'aggressive'` | `'normal'` | `'aggressive'` produces terse bullet points at half the token budget |
| `preserveTerms` | `string[]` | — | Domain-specific terms appended to the built-in preserve list |

### createEscalatingSummarizer

Three-level escalation summarizer (normal → aggressive → deterministic fallback):

1. **Level 1: Normal** — concise prose summary via the LLM
2. **Level 2: Aggressive** — terse bullet points at half the token budget (if Level 1 fails or returns longer text)
3. **Level 3: Deterministic** — sentence extraction fallback via the compression pipeline

```ts
import { createEscalatingSummarizer, compress } from '@ultracontext/compression';

const summarizer = createEscalatingSummarizer(
  async (prompt) => myLlm.complete(prompt),
  {
    maxResponseTokens: 300,
    systemPrompt: 'This is a legal contract. Preserve all clause numbers.',
    preserveTerms: ['clause numbers', 'party names'],
  },
);

const result = await compress(messages, { summarizer });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxResponseTokens` | `number` | `300` | Hint for maximum tokens in the LLM response |
| `systemPrompt` | `string` | — | Domain-specific instructions prepended to the built-in rules |
| `preserveTerms` | `string[]` | — | Domain-specific terms appended to the built-in preserve list |

Note: `mode` is not accepted — the escalating summarizer manages both modes internally.

<br />

## LLM Summarizer Examples

The `summarizer` option accepts any function with the signature `(text: string) => string | Promise<string>`. Use `createSummarizer` to wrap your LLM call with an optimized prompt, or write the prompt yourself for full control.

### Anthropic (Claude)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createSummarizer, compress } from '@ultracontext/compression';

const anthropic = new Anthropic();

const summarizer = createSummarizer(async (prompt) => {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].type === 'text' ? msg.content[0].text : '';
});

const result = await compress(messages, { summarizer });
```

### OpenAI

```ts
import OpenAI from 'openai';
import { createSummarizer, compress } from '@ultracontext/compression';

const openai = new OpenAI();

const summarizer = createSummarizer(async (prompt) => {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content ?? '';
});

const result = await compress(messages, { summarizer });
```

### Google Gemini

```ts
import { GoogleGenAI } from '@google/genai';
import { createSummarizer, compress } from '@ultracontext/compression';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const summarizer = createSummarizer(async (prompt) => {
  const res = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
  });
  return res.text ?? '';
});

const result = await compress(messages, { summarizer });
```

### xAI (Grok)

xAI's API is OpenAI-compatible — use the OpenAI SDK with a different base URL:

```ts
import OpenAI from 'openai';
import { createSummarizer, compress } from '@ultracontext/compression';

const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const summarizer = createSummarizer(async (prompt) => {
  const res = await xai.chat.completions.create({
    model: 'grok-3-fast',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content ?? '';
});

const result = await compress(messages, { summarizer });
```

### Ollama

```ts
import { createSummarizer, compress } from '@ultracontext/compression';

const summarizer = createSummarizer(async (prompt) => {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3', prompt, stream: false }),
  });
  const json = await res.json();
  return json.response;
});

const result = await compress(messages, { summarizer });
```

### Any Provider

The summarizer is just a function. Use any HTTP API, local model, or custom logic:

```ts
// Simple truncation (no LLM needed)
const summarizer = (text: string) => text.slice(0, 200) + '...';

// Custom API
const summarizer = async (text: string) => {
  const res = await fetch('https://my-api.com/summarize', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return (await res.json()).summary;
};
```

If the summarizer throws or returns text longer than the input, the engine falls back to deterministic compression automatically.

<br />

## What Gets Preserved

The classifier automatically preserves content that should never be summarized:

| Content Type | Example | Preserved? |
|---|---|---|
| Code fences | `` ```ts const x = 1; ``` `` | Yes |
| SQL | `SELECT * FROM users WHERE ...` | Yes |
| JSON | `{"key": "value"}` | Yes |
| API keys | `sk-proj-abc123...` | Yes |
| URLs | `https://docs.example.com/api` | Yes |
| File paths | `/etc/config.json` | Yes |
| Short messages | `< 120 chars` | Yes |
| Tool calls | Messages with `tool_calls` array | Yes |
| System messages | `role: 'system'` (default) | Yes |
| Long prose | General discussion, explanations | **Compressed** |

Code-mixed messages get split: prose is summarized, code fences stay verbatim.

<br />

## Preservation Rules

Messages are preserved (never compressed) when any of these apply:

1. **Role** is in the `preserve` list (default: `['system']`)
2. **Recency** — within the last `recencyWindow` messages (default: 4)
3. **Tool calls** — message has a `tool_calls` array
4. **Short** — content under 120 characters
5. **Already compressed** — starts with `[summary:`
6. **Code with short prose** — has code fences but prose under 200 chars
7. **Structured content** — classifier detects T0 (code, SQL, keys, etc.)
8. **Valid JSON** — parseable JSON content
9. **Size guard** — compressed output would be larger than original

<br />

## Provenance Metadata

Every compressed message carries a `_uc_original` object in its `metadata` field:

```ts
{
  ids: string[];          // original message IDs this summary covers
  summary_id: string;     // deterministic ID (uc_sum_<hash>) for this summary
  parent_ids?: string[];  // summary_ids of prior compressions (provenance chain)
  version: number;        // sourceVersion at time of compression
}
```

- **`ids`** — always an array, even for single messages. These are the keys into the `verbatim` map.
- **`summary_id`** — derived from `ids` via djb2 hash. Deterministic: same input IDs always produce the same summary_id.
- **`parent_ids`** — present only when compressing already-compressed messages (re-compression). Forms a chain for multi-layer provenance tracking.
- **`version`** — mirrors `CompressOptions.sourceVersion`. Defaults to `0`.

<br />

## Running Tests & Benchmarks

```bash
# tests
npm test

# type check
npx tsc --noEmit

# benchmark
npm run bench
```

<br />

## Documentation

- [UltraContext Docs](https://ultracontext.ai/docs) — Full platform documentation
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — REST API docs
- [Source](https://github.com/ultracontext/ultracontext/tree/main/packages/compression) — This package

---

<p align="center">
  <a href="https://ultracontext.ai">Website</a>
  ·
  <a href="https://ultracontext.ai/docs">Docs</a>
  ·
  <a href="https://github.com/ultracontext/ultracontext/issues">Issues</a>
</p>
