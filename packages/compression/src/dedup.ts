import type { Message } from './types.js';

export type DedupAnnotation = {
  duplicateOfIndex: number;
  contentLength: number;
};

/**
 * Scan messages for exact content duplicates. Returns a map of message indices
 * to their dedup annotations (marking earlier occurrences for replacement).
 *
 * Skips hard-preserved messages: system role, tool_calls, [summary: prefix,
 * content < 200 chars. Uses djb2 hashing for grouping with full string
 * comparison to eliminate collisions.
 */
export function analyzeDuplicates(
  messages: Message[],
  recencyStart: number,
  preserveRoles: Set<string>,
): Map<number, DedupAnnotation> {
  const annotations = new Map<number, DedupAnnotation>();

  // Phase 1: Hash eligible messages and group by hash
  const hashGroups = new Map<number, number[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Skip ineligible messages
    if (msg.role && preserveRoles.has(msg.role)) continue;
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
    if (content.startsWith('[summary:')) continue;
    if (content.length < 200) continue;

    const hash = djb2(content);
    let group = hashGroups.get(hash);
    if (!group) {
      group = [];
      hashGroups.set(hash, group);
    }
    group.push(i);
  }

  // Phase 2: Full string comparison within each hash group
  for (const indices of hashGroups.values()) {
    if (indices.length < 2) continue;

    // Sub-group by exact content match
    const exactGroups = new Map<string, number[]>();
    for (const idx of indices) {
      const content = messages[idx].content as string;
      let group = exactGroups.get(content);
      if (!group) {
        group = [];
        exactGroups.set(content, group);
      }
      group.push(idx);
    }

    for (const group of exactGroups.values()) {
      if (group.length < 2) continue;

      // Determine the "keep" target: prefer an occurrence in the recency window,
      // otherwise keep the latest occurrence.
      let keepIdx = group[group.length - 1]; // default: latest
      for (const idx of group) {
        if (idx >= recencyStart && recencyStart > 0) {
          keepIdx = idx;
          break;
        }
      }

      // Mark all others as duplicates
      const contentLength = (messages[keepIdx].content as string).length;
      for (const idx of group) {
        if (idx !== keepIdx) {
          annotations.set(idx, { duplicateOfIndex: keepIdx, contentLength });
        }
      }
    }
  }

  return annotations;
}

/** djb2 hash with length prefix to reduce collisions on similar-length content. */
function djb2(str: string): number {
  const prefixed = `${str.length}:${str}`;
  let h = 5381;
  for (let i = 0; i < prefixed.length; i++) {
    h = ((h << 5) + h + prefixed.charCodeAt(i)) >>> 0;
  }
  return h;
}
