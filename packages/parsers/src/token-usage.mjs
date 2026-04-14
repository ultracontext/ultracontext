// extract token usage from Claude Code parsed events
// deduplicates by message.id (streaming creates multiple rows per message)
export function extractClaudeTokenUsage(events) {
  const byMessageId = new Map();

  for (const event of events) {
    if (event.kind !== "assistant") continue;

    const msg = event.raw?.message ?? event.raw;
    const id = msg?.id;
    const usage = msg?.usage;
    if (!id || !usage) continue;

    // keep entry with highest output_tokens per message id
    const existing = byMessageId.get(id);
    if (!existing || (usage.output_tokens ?? 0) > (existing.output_tokens ?? 0)) {
      byMessageId.set(id, usage);
    }
  }

  // aggregate totals
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const u of byMessageId.values()) {
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
    cacheCreation += u.cache_creation_input_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreation,
    cacheRead,
    apiCallCount: byMessageId.size,
  };
}
