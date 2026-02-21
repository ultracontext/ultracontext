import { describe, it, expect, vi } from 'vitest';
import { createSummarizer, createEscalatingSummarizer } from '../src/summarizer.js';

describe('createSummarizer', () => {
  it('returns a function', () => {
    const summarizer = createSummarizer(() => 'summary');
    expect(typeof summarizer).toBe('function');
  });

  it('calls callLlm with prompt containing the input text', async () => {
    const callLlm = vi.fn().mockReturnValue('summary');
    const summarizer = createSummarizer(callLlm);

    await summarizer('Hello world, this is some input text.');

    expect(callLlm).toHaveBeenCalledOnce();
    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('Hello world, this is some input text.');
  });

  it('prompt includes preservation rules', async () => {
    const callLlm = vi.fn().mockReturnValue('summary');
    const summarizer = createSummarizer(callLlm);

    await summarizer('some text');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('code references');
    expect(prompt).toContain('file paths');
    expect(prompt).toContain('function/variable names');
    expect(prompt).toContain('URLs');
    expect(prompt).toContain('API keys');
    expect(prompt).toContain('error messages');
    expect(prompt).toContain('technical decisions');
  });

  it('includes custom maxResponseTokens in prompt', async () => {
    const callLlm = vi.fn().mockReturnValue('summary');
    const summarizer = createSummarizer(callLlm, { maxResponseTokens: 500 });

    await summarizer('some text');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('500 tokens');
  });

  it('includes default maxResponseTokens (300) in prompt', async () => {
    const callLlm = vi.fn().mockReturnValue('summary');
    const summarizer = createSummarizer(callLlm);

    await summarizer('some text');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('300 tokens');
  });

  it('works with sync callLlm', () => {
    const summarizer = createSummarizer(() => 'sync result');
    const result = summarizer('input');
    expect(result).toBe('sync result');
  });

  it('works with async callLlm', async () => {
    const summarizer = createSummarizer(async () => 'async result');
    const result = await summarizer('input');
    expect(result).toBe('async result');
  });

  it('passes through LLM result as-is', async () => {
    const longResult = 'This is a very long summary that might even be longer than the input.';
    const callLlm = vi.fn().mockReturnValue(longResult);
    const summarizer = createSummarizer(callLlm);

    const result = await summarizer('short');
    expect(result).toBe(longResult);
  });

  it('propagates errors from callLlm', async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error('LLM failed'));
    const summarizer = createSummarizer(callLlm);

    await expect(summarizer('input')).rejects.toThrow('LLM failed');
  });

  describe('systemPrompt', () => {
    it('appears at the start of the prompt when set', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, {
        systemPrompt: 'This is a legal contract. Preserve all clause numbers.',
      });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt.startsWith('This is a legal contract. Preserve all clause numbers.')).toBe(true);
    });

    it('built-in rules still present when systemPrompt is set', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, {
        systemPrompt: 'Domain context here.',
      });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('code references');
      expect(prompt).toContain('file paths');
      expect(prompt).toContain('Output ONLY the summary');
    });

    it('prompt unchanged when systemPrompt is omitted', async () => {
      const withoutPrompt = vi.fn().mockReturnValue('summary');
      const withUndefined = vi.fn().mockReturnValue('summary');

      const s1 = createSummarizer(withoutPrompt);
      const s2 = createSummarizer(withUndefined, { systemPrompt: undefined });

      await s1('some text');
      await s2('some text');

      expect(withoutPrompt.mock.calls[0][0]).toBe(withUndefined.mock.calls[0][0]);
    });

    it('prompt unchanged when systemPrompt is empty string', async () => {
      const withoutPrompt = vi.fn().mockReturnValue('summary');
      const withEmpty = vi.fn().mockReturnValue('summary');

      const s1 = createSummarizer(withoutPrompt);
      const s2 = createSummarizer(withEmpty, { systemPrompt: '' });

      await s1('some text');
      await s2('some text');

      expect(withoutPrompt.mock.calls[0][0]).toBe(withEmpty.mock.calls[0][0]);
    });
  });

  describe('mode', () => {
    it('aggressive mode produces terse bullet points instruction', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, { mode: 'aggressive' });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('terse bullet points');
    });

    it('aggressive mode halves the default token budget', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, { mode: 'aggressive' });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('150 tokens');
    });

    it('aggressive mode halves explicit maxResponseTokens', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, { mode: 'aggressive', maxResponseTokens: 400 });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('200 tokens');
    });

    it('aggressive mode still includes preservation rules and systemPrompt', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, {
        mode: 'aggressive',
        systemPrompt: 'Domain context.',
      });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('code references');
      expect(prompt).toContain('file paths');
      expect(prompt.startsWith('Domain context.')).toBe(true);
    });

    it('default (no mode) produces identical prompt to mode: normal', async () => {
      const noMode = vi.fn().mockReturnValue('summary');
      const normalMode = vi.fn().mockReturnValue('summary');

      const s1 = createSummarizer(noMode);
      const s2 = createSummarizer(normalMode, { mode: 'normal' });

      await s1('some text');
      await s2('some text');

      expect(noMode.mock.calls[0][0]).toBe(normalMode.mock.calls[0][0]);
    });
  });

  describe('preserveTerms', () => {
    it('single term appears in the preserve line', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, { preserveTerms: ['contract clauses'] });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('contract clauses');
    });

    it('multiple terms all appear with correct Oxford comma grammar', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const summarizer = createSummarizer(callLlm, {
        preserveTerms: ['contract clauses', 'party names'],
      });

      await summarizer('some text');

      const prompt = callLlm.mock.calls[0][0] as string;
      expect(prompt).toContain('contract clauses');
      expect(prompt).toContain('party names');
      // The last term should be preceded by ", and "
      expect(prompt).toContain(', and party names');
    });

    it('duplicate of a base term is filtered out', async () => {
      const callLlm = vi.fn().mockReturnValue('summary');
      const withDup = vi.fn().mockReturnValue('summary');

      const s1 = createSummarizer(callLlm, { preserveTerms: [] });
      const s2 = createSummarizer(withDup, { preserveTerms: ['file paths'] });

      await s1('some text');
      await s2('some text');

      // "file paths" is a base term — adding it as preserveTerms should not change the prompt
      expect(callLlm.mock.calls[0][0]).toBe(withDup.mock.calls[0][0]);
    });

    it('empty array produces identical prompt to no preserveTerms', async () => {
      const noTerms = vi.fn().mockReturnValue('summary');
      const emptyTerms = vi.fn().mockReturnValue('summary');

      const s1 = createSummarizer(noTerms);
      const s2 = createSummarizer(emptyTerms, { preserveTerms: [] });

      await s1('some text');
      await s2('some text');

      expect(noTerms.mock.calls[0][0]).toBe(emptyTerms.mock.calls[0][0]);
    });
  });
});

describe('createEscalatingSummarizer', () => {
  it('returns a function', () => {
    const summarizer = createEscalatingSummarizer(() => 'summary');
    expect(typeof summarizer).toBe('function');
  });

  it('Level 1 succeeds (shorter result) — callLlm called once', async () => {
    const input = 'This is a long input text that should be summarizable into fewer characters.';
    const callLlm = vi.fn().mockResolvedValue('Short summary.');
    const summarizer = createEscalatingSummarizer(callLlm);

    const result = await summarizer(input);

    expect(result).toBe('Short summary.');
    expect(callLlm).toHaveBeenCalledOnce();
  });

  it('Level 1 returns longer text — escalates to Level 2', async () => {
    const input = 'Short.';
    const callLlm = vi.fn()
      .mockResolvedValueOnce('This summary is actually longer than the original input text.')
      .mockResolvedValueOnce('Bullet result.');
    const summarizer = createEscalatingSummarizer(callLlm);

    const result = await summarizer(input);

    expect(result).toBe('Bullet result.');
    expect(callLlm).toHaveBeenCalledTimes(2);
    // Second call should be aggressive
    const secondPrompt = callLlm.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('terse bullet points');
  });

  it('Level 1 returns empty string — escalates to Level 2', async () => {
    const input = 'Some input text that needs summarizing for the test to make sense.';
    const callLlm = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Aggressive result.');
    const summarizer = createEscalatingSummarizer(callLlm);

    const result = await summarizer(input);

    expect(result).toBe('Aggressive result.');
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it('Level 1 throws — escalates to Level 2', async () => {
    const input = 'Some input text that needs summarizing for the test to make sense.';
    const callLlm = vi.fn()
      .mockRejectedValueOnce(new Error('Rate limited'))
      .mockResolvedValueOnce('Fallback result.');
    const summarizer = createEscalatingSummarizer(callLlm);

    const result = await summarizer(input);

    expect(result).toBe('Fallback result.');
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it('Level 2 throws — error propagates', async () => {
    const input = 'Some input text that needs summarizing for the test to make sense.';
    const callLlm = vi.fn()
      .mockRejectedValueOnce(new Error('Rate limited'))
      .mockRejectedValueOnce(new Error('Service down'));
    const summarizer = createEscalatingSummarizer(callLlm);

    await expect(summarizer(input)).rejects.toThrow('Service down');
  });

  it('systemPrompt and preserveTerms appear in both Level 1 and Level 2 prompts', async () => {
    const input = 'Short.';
    const callLlm = vi.fn()
      .mockResolvedValueOnce('This is longer than the original short text input.')
      .mockResolvedValueOnce('Done.');
    const summarizer = createEscalatingSummarizer(callLlm, {
      systemPrompt: 'Legal domain.',
      preserveTerms: ['clause numbers'],
    });

    await summarizer(input);

    expect(callLlm).toHaveBeenCalledTimes(2);
    const [prompt1, prompt2] = callLlm.mock.calls.map(c => c[0] as string);
    // Both prompts include systemPrompt
    expect(prompt1.startsWith('Legal domain.')).toBe(true);
    expect(prompt2.startsWith('Legal domain.')).toBe(true);
    // Both prompts include preserveTerms
    expect(prompt1).toContain('clause numbers');
    expect(prompt2).toContain('clause numbers');
  });

  it('always returns a Promise', () => {
    const callLlm = vi.fn().mockReturnValue('sync result');
    const summarizer = createEscalatingSummarizer(callLlm);

    const result = summarizer('input');
    expect(result).toBeInstanceOf(Promise);
  });
});
