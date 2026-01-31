<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/og-node.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">The context API for AI agents.</h3>

<p align="center">
  <a href="https://ultracontext.ai/docs/quickstart/nodejs">Quickstart</a>
  ·
  <a href="https://ultracontext.ai/docs">Documentation</a>
  ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ultracontext">
    <img src="https://img.shields.io/npm/v/ultracontext" alt="npm version" />
  </a>
  <a href="https://github.com/ultracontext/ultracontext-node/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/ultracontext?v=1" alt="license" />
  </a>
</p>

<br />

<p align="center">📚 Guides</p>
<p align="center">
  <a href="https://ultracontext.ai/docs/guides/store-retrieve-contexts">Store & Retrieve</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/edit-contexts">Edit Contexts</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/fork-clone-contexts">Fork & Clone</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/view-context-history">View History</a>
</p>

<br />

UltraContext is the simplest way to control what your agents see.

Replace messages, compact/offload context, replay decisions and roll back mistakes — with a single API call. Versioned context out of the box. Full history. Zero complexity.

## Why Context Matters

Context is the RAM of LLMs — everything they can see.

As context grows, model attention spreads thin — this is known as **context rot**. We should aim to provide the smallest set of high-signal tokens that get the job done.

Right now, we're reinventing the wheel for every car we build. Instead of tackling interesting problems, we catch ourselves spending most of our time gluing context together.

**It's time to simplify.**

## Why UltraContext

- **Simple API** — Five methods. That's it.
- **Automatic versioning** — Updates/deletes create versions. Nothing is lost.
- **Time-travel** — Jump to any point by version, index, or timestamp.
- **Schema-free** — Store any JSON. Own your data structure.
- **Framework-agnostic** — Works with any LLM framework.
- **Fast** — Globally distributed. Low latency.

Just plug & play.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext-node&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext-node&type=date&legend=top-left)

## Install

```bash
npm install ultracontext
```

## 🚀 Quick Start

```js
import { UltraContext } from 'ultracontext';

const uc = new UltraContext({ apiKey: 'uc_live_...' });

const ctx = await uc.create();
await uc.append(ctx.id, { role: 'user', content: 'Hello!' });

// use with any LLM framework
const response = await generateText({ model, messages: ctx.data });
```

Get an API key from the [UltraContext Dashboard](https://ultracontext.ai/dashboard).

## API

```js
// create - new context or fork from existing
const ctx = await uc.create();
const fork = await uc.create({ from: 'ctx_abc123' });

// get - retrieve context (supports version, index, timestamp)
const { data } = await uc.get('ctx_abc123');
const { data } = await uc.get('ctx_abc123', { version: 2 });
const { data } = await uc.get('ctx_abc123', { at: 5 });
const { data, versions } = await uc.get('ctx_abc123', { history: true });

// append - add messages (schema-free)
await uc.append(ctx.id, { role: 'user', content: 'Hi' });
await uc.append(ctx.id, [{ role: 'user', content: 'Hi' }, { foo: 'bar' }]);

// update - modify by id or index (auto-versions)
await uc.update(ctx.id, { id: 'msg_xyz', content: 'Fixed!' });
await uc.update(ctx.id, { index: -1, content: 'Fix last message' });

// delete - remove by id or index (auto-versions)
await uc.delete(ctx.id, 'msg_xyz');
await uc.delete(ctx.id, -1);
```

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart/nodejs) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation

## License

MIT

---

<p align="center">
  <a href="https://ultracontext.ai">Website</a>
  ·
  <a href="https://ultracontext.ai/docs">Docs</a>
  ·
  <a href="https://github.com/ultracontext/ultracontext-node/issues">Issues</a>
</p>
