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

- **Lossless round-trip** — `compress` then `expand` restores byte-identical originals
- **Code-aware** — Fences, SQL, JSON, API keys, URLs, and file paths stay verbatim
- **LLM-powered** — Plug in any summarizer (Claude, GPT, Ollama, etc.) for higher-quality summaries
- **Budget-driven** — `compressToFit` automatically finds the right compression level for a token budget
- **Searchable** — `searchVerbatim` finds original messages by regex after compression
- **Zero dependencies** — Pure TypeScript, no crypto, no network calls

<br />

## Install

```bash
npm install @ultracontext/compression
```

<br />

## Quick Start

```ts
import { compressMessages, expandMessages } from '@ultracontext/compression';

// compress — prose gets summarized, code stays verbatim
const { messages, verbatim, compression } = compressMessages(messages, {
  preserve: ['system'],  // roles to never compress
  recencyWindow: 4,      // protect the last N messages
});

// expand — restore originals from the verbatim store
const { messages: originals } = expandMessages(messages, verbatim);
```

**Important:** `messages` and `verbatim` must be persisted together atomically. Writing compressed messages without their verbatim originals causes irrecoverable data loss.

<br />

## API

### compressMessages

Deterministic compression. Summarizes prose, preserves code and structured content.

```ts
import { compressMessages } from '@ultracontext/compression';

const result = compressMessages(messages, {
  preserve: ['system'],   // roles to never compress (default: ['system'])
  recencyWindow: 4,        // protect last N messages (default: 4)
  sourceVersion: 1,        // version tag for provenance tracking
});

result.messages;                        // compressed message array
result.verbatim;                        // original messages keyed by ID
result.compression.ratio;               // char compression ratio (>1 = savings)
result.compression.token_ratio;         // token compression ratio (>1 = savings)
result.compression.messages_compressed; // how many were compressed
result.compression.messages_preserved;  // how many were kept as-is
```

### compressMessagesAsync

Same as `compressMessages`, but supports an LLM-powered summarizer for higher-quality summaries.

Three-level fallback per message:
1. **LLM summarizer** — uses the result if shorter than the original
2. **Deterministic** — sentence extraction + entity preservation
3. **Size guard** — preserves original if compression would increase size

```ts
import { compressMessagesAsync } from '@ultracontext/compression';

const result = await compressMessagesAsync(messages, {
  recencyWindow: 4,
  summarizer: async (text) => {
    // your LLM call here — return a shorter string
    return await myLlm.summarize(text);
  },
});
```

The sync `compressMessages` throws if you pass a `summarizer` to prevent silent misconfiguration.

### expandMessages

Restore originals from the verbatim store. Supports recursive expansion for multi-layer compression.

```ts
import { expandMessages } from '@ultracontext/compression';

const { messages, missing_ids } = expandMessages(compressed, verbatim);

// recursive — follows chains of compressed-then-recompressed messages
const deep = expandMessages(compressed, verbatim, { recursive: true });

// missing_ids.length > 0 means data loss (partial write)
```

### compressToFit

Budget-driven compression. Automatically searches for the least compression needed to fit a token budget.

```ts
import { compressToFit } from '@ultracontext/compression';

const result = compressToFit(messages, 4000, {
  minRecencyWindow: 2,  // never compress the last 2 messages
});

result.fits;          // true if result fits within budget
result.recencyWindow; // final recencyWindow used
result.tokenCount;    // estimated token count
result.messages;      // compressed messages
result.verbatim;      // verbatim store
```

Use `compressToFitAsync` to combine budget-driven compression with an LLM summarizer:

```ts
import { compressToFitAsync } from '@ultracontext/compression';

const result = await compressToFitAsync(messages, 4000, {
  summarizer: mySummarizer,
  minRecencyWindow: 2,
});
```

### searchVerbatim

Search the verbatim store for original messages matching a pattern.

```ts
import { searchVerbatim } from '@ultracontext/compression';

const results = searchVerbatim(compressed, verbatim, /authentication/i);

for (const hit of results) {
  hit.summaryId;  // uc_sum_XXX — which summary covers this message
  hit.messageId;  // original message ID
  hit.content;    // full original message content
  hit.matches;    // matched strings
}
```

Accepts `RegExp` or `string`. Adds the `g` flag automatically if missing.

### estimateTokens

Quick token estimate for a single message (~3.5 chars/token).

```ts
import { estimateTokens } from '@ultracontext/compression';

const tokens = estimateTokens(message);
```

### classifyMessage

Classify a message's content as structured (T0), mixed (T2), or prose (T3).

```ts
import { classifyMessage } from '@ultracontext/compression';

const { decision, confidence, reasons } = classifyMessage(content);
// decision: 'T0' (preserve) | 'T2' (mixed) | 'T3' (compressible)
```

<br />

## LLM Summarizer Examples

The `summarizer` option accepts any function with the signature `(text: string) => string | Promise<string>`. Here are examples for common providers.

### Anthropic (Claude)

```ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const summarizer = async (text: string) => {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarize this concisely, preserving technical details:\n\n${text}`,
    }],
  });
  return msg.content[0].type === 'text' ? msg.content[0].text : text;
};

const result = await compressMessagesAsync(messages, { summarizer });
```

### OpenAI

```ts
import OpenAI from 'openai';

const openai = new OpenAI();

const summarizer = async (text: string) => {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarize this concisely, preserving technical details:\n\n${text}`,
    }],
  });
  return res.choices[0].message.content ?? text;
};

const result = await compressMessagesAsync(messages, { summarizer });
```

### Google Gemini

```ts
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const summarizer = async (text: string) => {
  const res = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: `Summarize this concisely, preserving technical details:\n\n${text}`,
  });
  return res.text ?? text;
};

const result = await compressMessagesAsync(messages, { summarizer });
```

### xAI (Grok)

xAI's API is OpenAI-compatible — use the OpenAI SDK with a different base URL:

```ts
import OpenAI from 'openai';

const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const summarizer = async (text: string) => {
  const res = await xai.chat.completions.create({
    model: 'grok-3-fast',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarize this concisely, preserving technical details:\n\n${text}`,
    }],
  });
  return res.choices[0].message.content ?? text;
};

const result = await compressMessagesAsync(messages, { summarizer });
```

### Ollama

```ts
const summarizer = async (text: string) => {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3',
      prompt: `Summarize this concisely, preserving technical details:\n\n${text}`,
      stream: false,
    }),
  });
  const json = await res.json();
  return json.response;
};

const result = await compressMessagesAsync(messages, { summarizer });
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
