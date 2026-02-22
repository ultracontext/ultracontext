import type { Message } from './types.js';

export type DedupAnnotation = {
  duplicateOfIndex: number;
  contentLength: number;
  similarity?: number; // undefined = exact match, 0-1 = fuzzy score
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

/**
 * Scan messages for near-duplicate content using line-level Jaccard similarity.
 * Returns a map of message indices to their fuzzy-dedup annotations.
 *
 * Complexity: O(n^2) in the worst case (all messages land in one fingerprint
 * bucket), but effectively O(n * k) in practice due to two pre-filters:
 * 1. Length-ratio filter: skip pairs where min/max length ratio < 0.7
 * 2. Line-fingerprint bucketing: group by first 5 non-empty normalized lines
 *    (requires >= 3 shared lines to be in the same bucket)
 */
export function analyzeFuzzyDuplicates(
  messages: Message[],
  recencyStart: number,
  preserveRoles: Set<string>,
  exactAnnotations: Map<number, DedupAnnotation>,
  threshold: number,
): Map<number, DedupAnnotation> {
  const annotations = new Map<number, DedupAnnotation>();

  // Phase 1: Build eligible list with normalized lines
  type Eligible = {
    index: number;
    contentLength: number;
    lines: string[];           // normalized lines for Jaccard
    fingerprint: string[];     // first 5 non-empty normalized lines
  };

  const eligible: Eligible[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Same skip criteria as analyzeDuplicates
    if (msg.role && preserveRoles.has(msg.role)) continue;
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
    if (content.startsWith('[summary:')) continue;
    if (content.length < 200) continue;

    // Skip indices already handled by exact dedup
    if (exactAnnotations.has(i)) continue;

    const rawLines = content.split('\n');
    const normalized: string[] = [];
    const fp: string[] = [];
    for (const line of rawLines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.length > 0) {
        normalized.push(trimmed);
        if (fp.length < 5) fp.push(trimmed);
      }
    }

    // Need at least a few lines for meaningful comparison
    if (normalized.length < 2) continue;

    eligible.push({
      index: i,
      contentLength: content.length,
      lines: normalized,
      fingerprint: fp,
    });
  }

  if (eligible.length < 2) return annotations;

  // Phase 2: Bucket by fingerprint overlap (>= 3 shared first-5-lines)
  // Build inverted index: fingerprint line → list of eligible indices
  const fpIndex = new Map<string, number[]>();
  for (let ei = 0; ei < eligible.length; ei++) {
    for (const fpLine of eligible[ei].fingerprint) {
      let bucket = fpIndex.get(fpLine);
      if (!bucket) {
        bucket = [];
        fpIndex.set(fpLine, bucket);
      }
      bucket.push(ei);
    }
  }

  // Find candidate pairs: eligible indices that share >= 3 fingerprint lines
  const candidatePairs = new Set<string>();
  for (let ei = 0; ei < eligible.length; ei++) {
    const overlapCount = new Map<number, number>();
    for (const fpLine of eligible[ei].fingerprint) {
      const bucket = fpIndex.get(fpLine)!;
      for (const ej of bucket) {
        if (ej <= ei) continue; // only look forward to avoid duplicate pairs
        overlapCount.set(ej, (overlapCount.get(ej) ?? 0) + 1);
      }
    }
    for (const [ej, count] of overlapCount) {
      if (count >= 3) {
        candidatePairs.add(`${ei}:${ej}`);
      }
    }
  }

  // Phase 3: Compare candidates with length-ratio pre-filter, then Jaccard
  // Track groups of fuzzy-duplicates: map content fingerprint → list of eligible indices
  type FuzzyMatch = { eiA: number; eiB: number; similarity: number };
  const matches: FuzzyMatch[] = [];

  for (const pair of candidatePairs) {
    const [a, b] = pair.split(':').map(Number);
    const ea = eligible[a];
    const eb = eligible[b];

    // Length-ratio pre-filter
    const minLen = Math.min(ea.contentLength, eb.contentLength);
    const maxLen = Math.max(ea.contentLength, eb.contentLength);
    if (minLen / maxLen < 0.7) continue;

    const sim = jaccardLines(ea.lines, eb.lines);
    if (sim >= threshold) {
      matches.push({ eiA: a, eiB: b, similarity: sim });
    }
  }

  // Phase 4: Build fuzzy-duplicate groups and determine keep targets
  // Use union-find to group transitively connected fuzzy-duplicates
  const parent = new Array(eligible.length).fill(0).map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const m of matches) {
    union(m.eiA, m.eiB);
  }

  // Group by root
  const groups = new Map<number, number[]>();
  for (let ei = 0; ei < eligible.length; ei++) {
    const root = find(ei);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(ei);
  }

  // Build similarity lookup for annotations
  const simLookup = new Map<string, number>();
  for (const m of matches) {
    simLookup.set(`${m.eiA}:${m.eiB}`, m.similarity);
    simLookup.set(`${m.eiB}:${m.eiA}`, m.similarity);
  }

  // For each group with 2+ members: keep latest (prefer recency window), mark others
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Sort by original message index
    group.sort((a, b) => eligible[a].index - eligible[b].index);

    // Determine keep target: prefer first occurrence in recency window, else latest
    let keepEi = group[group.length - 1]; // default: latest
    if (recencyStart > 0) {
      for (const ei of group) {
        if (eligible[ei].index >= recencyStart) {
          keepEi = ei;
          break;
        }
      }
    }

    const keepIdx = eligible[keepEi].index;

    // Mark all others as fuzzy-duplicates
    for (const ei of group) {
      if (ei === keepEi) continue;
      const msgIdx = eligible[ei].index;
      // Find similarity to the keep target
      const sim = simLookup.get(`${ei}:${keepEi}`) ?? simLookup.get(`${keepEi}:${ei}`) ?? jaccardLines(eligible[ei].lines, eligible[keepEi].lines);
      annotations.set(msgIdx, {
        duplicateOfIndex: keepIdx,
        contentLength: eligible[ei].contentLength,
        similarity: sim,
      });
    }
  }

  return annotations;
}

/** Line-level Jaccard similarity using multiset (frequency map) intersection/union. */
function jaccardLines(a: string[], b: string[]): number {
  const freqA = new Map<string, number>();
  for (const line of a) freqA.set(line, (freqA.get(line) ?? 0) + 1);

  const freqB = new Map<string, number>();
  for (const line of b) freqB.set(line, (freqB.get(line) ?? 0) + 1);

  let intersection = 0;
  let union = 0;

  // Process all keys from A
  for (const [line, countA] of freqA) {
    const countB = freqB.get(line) ?? 0;
    intersection += Math.min(countA, countB);
    union += Math.max(countA, countB);
  }

  // Process keys only in B
  for (const [line, countB] of freqB) {
    if (!freqA.has(line)) {
      union += countB;
    }
  }

  return union === 0 ? 1 : intersection / union;
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
