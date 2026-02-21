import type { ExpandOptions, ExpandResult, Message, VerbatimMap } from './types.js';

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
