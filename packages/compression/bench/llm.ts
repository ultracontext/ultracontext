/**
 * LLM provider detection for benchmarking.
 *
 * Detects available providers from environment variables and returns
 * callLlm functions compatible with createSummarizer().
 *
 * Supported providers:
 *   - OpenAI:    OPENAI_API_KEY (model override: OPENAI_MODEL, default gpt-4.1-mini)
 *   - Ollama:    OLLAMA_MODEL or OLLAMA_HOST (default host http://localhost:11434, model llama3.2)
 *   - Anthropic: ANTHROPIC_API_KEY (model override: ANTHROPIC_MODEL, default claude-haiku-4-5-20251001)
 *
 * SDKs are dynamically imported — missing packages print a skip message
 * instead of crashing.
 */

export type LlmProvider = {
  name: string;
  model: string;
  callLlm: (prompt: string) => Promise<string>;
};

export async function detectProviders(): Promise<LlmProvider[]> {
  const providers: LlmProvider[] = [];

  // --- OpenAI ---
  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

      providers.push({
        name: 'openai',
        model,
        callLlm: async (prompt: string): Promise<string> => {
          const r = await client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
            temperature: 0.3,
          });
          return r.choices[0]?.message?.content ?? '';
        },
      });
    } catch (err) {
      console.log(`  OpenAI SDK not installed, skipping (${(err as Error).message})`);
    }
  }

  // --- Ollama (OpenAI-compatible API) ---
  if (process.env.OLLAMA_MODEL || process.env.OLLAMA_HOST) {
    try {
      const { default: OpenAI } = await import('openai');
      const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL ?? 'llama3.2';
      const client = new OpenAI({ baseURL: `${host}/v1`, apiKey: 'ollama' });

      providers.push({
        name: 'ollama',
        model,
        callLlm: async (prompt: string): Promise<string> => {
          const r = await client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
            temperature: 0.3,
          });
          return r.choices[0]?.message?.content ?? '';
        },
      });
    } catch (err) {
      console.log(`  OpenAI SDK not installed (needed for Ollama), skipping (${(err as Error).message})`);
    }
  }

  // --- Anthropic ---
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

      providers.push({
        name: 'anthropic',
        model,
        callLlm: async (prompt: string): Promise<string> => {
          const msg = await client.messages.create({
            model,
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }],
          });
          const block = msg.content[0];
          return block.type === 'text' ? block.text : '';
        },
      });
    } catch (err) {
      console.log(`  Anthropic SDK not installed, skipping (${(err as Error).message})`);
    }
  }

  return providers;
}
