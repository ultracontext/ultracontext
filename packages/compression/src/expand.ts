import type { ExpandOptions, ExpandResult, Message, SearchResult, VerbatimMap } from './types.js';

type StoreLookup = VerbatimMap | ((id: string) => Message | undefined);

function lookup(store: StoreLookup, id: string): Message | undefined {
  return typeof store === 'function' ? store(id) : store[id];
}

function hasOriginal(msg: Message): msg is Message & { metadata: { _uc_original: { ids: string[] } } } {
  const orig = msg.metadata?._uc_original as Record<string, unknown> | undefined;
  return Array.isArray(orig?.ids) && (orig!.ids as unknown[]).length > 0;
}

function expandOnce(messages: Message[], store: StoreLookup): ExpandResult {
  const out: Message[] = [];
  let expanded = 0;
  let passthrough = 0;
  const missingIds: string[] = [];

  for (const msg of messages) {
    if (!hasOriginal(msg)) {
      out.push(msg);
      passthrough++;
      continue;
    }

    const ids: string[] = (msg.metadata._uc_original as { ids: string[] }).ids;
    const originals: Message[] = [];
    const missing: string[] = [];

    for (const id of ids) {
      const found = lookup(store, id);
      if (found) {
        originals.push(found);
      } else {
        missing.push(id);
      }
    }

    if (originals.length === 0) {
      // All IDs missing — keep summary as fallback
      out.push(msg);
      passthrough++;
      missingIds.push(...missing);
    } else {
      for (const orig of originals) {
        out.push(orig);
      }
      expanded++;
      missingIds.push(...missing);
    }
  }

  return {
    messages: out,
    messages_expanded: expanded,
    messages_passthrough: passthrough,
    missing_ids: missingIds,
  };
}

/**
 * Restore original messages from compressed output using a verbatim store.
 *
 * Non-empty `missing_ids` in the result indicates data loss — typically
 * from a non-atomic write where compressed messages were persisted but
 * their verbatim originals were not.
 */
export function expandMessages(
  messages: Message[],
  store: StoreLookup,
  options?: ExpandOptions,
): ExpandResult {
  let result = expandOnce(messages, store);

  if (options?.recursive) {
    let hasMore = result.messages.some(m => hasOriginal(m));
    while (hasMore) {
      const next = expandOnce(result.messages, store);
      result = {
        messages: next.messages,
        messages_expanded: result.messages_expanded + next.messages_expanded,
        messages_passthrough: next.messages_passthrough,
        missing_ids: [...result.missing_ids, ...next.missing_ids],
      };
      hasMore = next.messages_expanded > 0 && next.messages.some(m => hasOriginal(m));
    }
  }

  return result;
}

/**
 * Search the verbatim store for messages matching a pattern.
 * Returns matches with their summary IDs for provenance tracking.
 */
export function searchVerbatim(
  compressed: Message[],
  verbatim: VerbatimMap,
  pattern: RegExp | string,
): SearchResult[] {
  // Build inverse map: original message ID → summaryId
  const idToSummary = new Map<string, string>();
  for (const msg of compressed) {
    if (!hasOriginal(msg)) continue;
    const orig = msg.metadata._uc_original as { ids: string[]; summary_id?: string };
    const summaryId = typeof orig.summary_id === 'string' ? orig.summary_id : '';
    for (const id of orig.ids) {
      idToSummary.set(id, summaryId);
    }
  }

  const re = typeof pattern === 'string'
    ? new RegExp(pattern, 'g')
    : pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');

  const results: SearchResult[] = [];
  for (const [id, msg] of Object.entries(verbatim)) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;

    re.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      matches.push(m[0]);
      if (m[0].length === 0) { re.lastIndex++; }
    }

    if (matches.length > 0) {
      results.push({
        summaryId: idToSummary.get(id) ?? id,
        messageId: id,
        content,
        matches,
      });
    }
  }

  return results;
}
