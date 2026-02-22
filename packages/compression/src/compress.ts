import { classifyMessage } from './classify.js';
import { analyzeDuplicates, analyzeFuzzyDuplicates, type DedupAnnotation } from './dedup.js';
import type { CompressOptions, CompressResult, Message, Summarizer } from './types.js';

/**
 * Deterministic summary ID from sorted source message IDs.
 * Uses djb2 to avoid a crypto dependency; collisions are acceptable
 * because the ID is advisory provenance, not a security primitive.
 */
function makeSummaryId(ids: string[]): string {
  const key = ids.length === 1 ? ids[0] : ids.slice().sort().join('\0');
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return `uc_sum_${h.toString(36)}`;
}

/**
 * Collect summary_ids from source messages that were themselves compressed,
 * forming a provenance chain.
 */
function collectParentIds(msgs: Message[]): string[] {
  const parents: string[] = [];
  for (const m of msgs) {
    const orig = m.metadata?._uc_original as Record<string, unknown> | undefined;
    if (orig?.summary_id && typeof orig.summary_id === 'string') {
      parents.push(orig.summary_id);
    }
  }
  return parents;
}

const FILLER_RE = /^(?:great|sure|ok|okay|thanks|thank you|got it|right|yes|no|alright|absolutely|exactly|indeed|cool|nice|perfect|wonderful|awesome|fantastic|sounds good|makes sense|i see|i understand|understood|noted|certainly|of course|no problem|no worries|will do|let me|i'll|i can|i would|well|so|now)[,.!?\s]/i;

const EMPHASIS_RE = /\b(?:importantly|note that|however|critical|crucial|essential|significant|notably|key point|in particular|specifically|must|require[ds]?|never|always)\b/i;

function scoreSentence(sentence: string): number {
  let score = 0;
  // camelCase identifiers
  score += (sentence.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3;
  // PascalCase identifiers
  score += (sentence.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3;
  // snake_case identifiers
  score += (sentence.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).length * 3;
  // Emphasis phrases
  if (EMPHASIS_RE.test(sentence)) score += 4;
  // Numbers with units
  score += (sentence.match(/\b\d+(?:\.\d+)?\s*(?:seconds?|ms|MB|GB|TB|KB|retries?|workers?|threads?|nodes?|replicas?|requests?|%)\b/gi) ?? []).length * 2;
  // Vowelless abbreviations (3+ consonants)
  score += (sentence.match(/\b[bcdfghjklmnpqrstvwxz]{3,}\b/gi) ?? []).length * 2;
  // PASS/FAIL/ERROR/WARNING/WARN status words
  score += (sentence.match(/\b(?:PASS|FAIL|ERROR|WARNING|WARN)\b/g) ?? []).length * 3;
  // Grep-style file:line references (e.g. src/foo.ts:42:)
  score += (sentence.match(/\S+\.\w+:\d+:/g) ?? []).length * 2;
  // Optimal length bonus
  if (sentence.length >= 40 && sentence.length <= 120) score += 2;
  // Filler penalty
  if (FILLER_RE.test(sentence.trim())) score -= 10;
  return score;
}

function summarize(text: string, maxBudget?: number): string {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  type Scored = { text: string; score: number; origIdx: number; primary: boolean };
  const allSentences: Scored[] = [];
  let globalIdx = 0;

  for (const para of paragraphs) {
    const sentences = para.match(/[^.!?\n]+[.!?]+/g);
    if (!sentences || sentences.length === 0) {
      const trimmed = para.trim();
      if (trimmed.length > 0) {
        allSentences.push({ text: trimmed, score: scoreSentence(trimmed), origIdx: globalIdx++, primary: true });
      }
      continue;
    }
    // Score all sentences, mark the best per paragraph as primary
    let bestIdx = 0;
    let bestScore = -Infinity;
    const paraSentences: Scored[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      const sc = scoreSentence(s);
      paraSentences.push({ text: s, score: sc, origIdx: globalIdx + i, primary: false });
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
      }
    }
    paraSentences[bestIdx].primary = true;
    allSentences.push(...paraSentences);
    globalIdx += sentences.length;
  }

  if (allSentences.length === 0) {
    return text.slice(0, budget).trim();
  }

  // Greedy budget packing: primary sentences first, then fill with others
  // Skip filler (negative score) and deduplicate by text
  const budget = maxBudget ?? 400;
  const selected: Scored[] = [];
  const seenText = new Set<string>();
  let usedChars = 0;

  const primaryByScore = allSentences.filter(s => s.primary && s.score >= 0).sort((a, b) => b.score - a.score);
  const secondaryByScore = allSentences.filter(s => !s.primary && s.score >= 0).sort((a, b) => b.score - a.score);

  for (const pool of [primaryByScore, secondaryByScore]) {
    for (const entry of pool) {
      if (seenText.has(entry.text)) continue;
      const separatorLen = selected.length > 0 ? 5 : 0;
      if (usedChars + separatorLen + entry.text.length <= budget) {
        selected.push(entry);
        seenText.add(entry.text);
        usedChars += separatorLen + entry.text.length;
      }
    }
  }

  // If nothing fits (all filler or all too long), take the highest-scored and truncate
  if (selected.length === 0) {
    const best = allSentences.slice().sort((a, b) => b.score - a.score)[0];
    const truncated = best.text.slice(0, budget).trim();
    return truncated.length > budget - 3 ? truncated.slice(0, budget - 3) + '...' : truncated;
  }

  // Re-sort by original position to preserve reading order
  selected.sort((a, b) => a.origIdx - b.origIdx);

  const result = selected.map(s => s.text).join(' ... ');
  if (result.length > budget) {
    return result.slice(0, budget - 3) + '...';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structured tool output detection and summarization
// ---------------------------------------------------------------------------

const STRUCTURAL_RE = /^(?:\S+\.\w+:\d+:|[ \t]+[-•*]|[ \t]*\w[\w ./-]*:\s|(?:PASS|FAIL|ERROR|WARNING|WARN|OK|SKIP)\b)/;

function isStructuredOutput(text: string): boolean {
  const lines = text.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 6) return false;

  const newlineDensity = (text.match(/\n/g) ?? []).length / text.length;
  if (newlineDensity < 1 / 80) return false;

  let structural = 0;
  for (const line of nonEmpty) {
    if (STRUCTURAL_RE.test(line)) structural++;
  }
  return structural / nonEmpty.length > 0.5;
}

function summarizeStructured(text: string, maxBudget: number): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // Extract file paths from grep-style output (file.ext:line:)
  const filePaths = new Set<string>();
  for (const line of nonEmpty) {
    const m = line.match(/^(\S+\.\w+):\d+:/);
    if (m) filePaths.add(m[1]);
  }

  // Extract status/summary lines (PASS/FAIL counts, duration, totals)
  const statusLines: string[] = [];
  for (const line of nonEmpty) {
    if (/\b(?:PASS|FAIL|ERROR|WARNING|WARN|Tests?|Total|Duration|passed|failed)\b/i.test(line)) {
      statusLines.push(line.trim());
    }
  }

  const parts: string[] = [];

  // File paths summary
  if (filePaths.size > 0) {
    const allPaths = Array.from(filePaths);
    const shown = allPaths.slice(0, 3).join(', ');
    if (allPaths.length > 3) {
      parts.push(`files: ${shown} +${allPaths.length - 3} more`);
    } else {
      parts.push(`files: ${shown}`);
    }
  }

  // Status lines (deduplicated)
  const seenStatus = new Set<string>();
  for (const s of statusLines) {
    if (!seenStatus.has(s) && seenStatus.size < 3) {
      seenStatus.add(s);
      parts.push(s);
    }
  }

  // If we got meaningful structured content, use it
  if (parts.length > 0) {
    let result = parts.join(' | ');
    if (result.length > maxBudget) {
      result = result.slice(0, maxBudget - 3) + '...';
    }
    return result;
  }

  // Fallback: head/tail with line count
  const head = nonEmpty.slice(0, 3).map(l => l.trim()).join(' | ');
  const tail = nonEmpty[nonEmpty.length - 1].trim();
  let result = `${head} | ... | ${tail} (${nonEmpty.length} lines)`;
  if (result.length > maxBudget) {
    result = result.slice(0, maxBudget - 3) + '...';
  }
  return result;
}

const COMMON_STARTERS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What',
  'Which', 'Who', 'How', 'Why', 'Here', 'There', 'Now', 'Then',
  'But', 'And', 'Or', 'So', 'If', 'It', 'Its', 'My', 'Your',
  'His', 'Her', 'Our', 'They', 'We', 'You', 'He', 'She', 'In',
  'On', 'At', 'To', 'For', 'With', 'From', 'As', 'By', 'An',
  'Each', 'Every', 'Some', 'All', 'Most', 'Many', 'Much', 'Any',
  'No', 'Not', 'Also', 'Just', 'Only', 'Even', 'Still', 'Yet',
  'Let', 'See', 'Note', 'Yes', 'Sure', 'Great', 'Thanks', 'Well',
  'First', 'Second', 'Third', 'Next', 'Last', 'Finally', 'However',
  'After', 'Before', 'Since', 'Once', 'While', 'Although', 'Because',
  'Unless', 'Until', 'About', 'Over', 'Under', 'Between', 'Into',
]);

function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // Proper nouns: capitalized words not at common sentence starters
  const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  if (properNouns) {
    for (const noun of properNouns) {
      const first = noun.split(/\s+/)[0];
      if (!COMMON_STARTERS.has(first)) {
        entities.add(noun);
      }
    }
  }

  // PascalCase identifiers (TypeScript, WebSocket, JavaScript, etc.)
  const pascalCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (pascalCase) {
    for (const id of pascalCase) entities.add(id);
  }

  // camelCase identifiers
  const camelCase = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (camelCase) {
    for (const id of camelCase) entities.add(id);
  }

  // snake_case identifiers
  const snakeCase = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g);
  if (snakeCase) {
    for (const id of snakeCase) entities.add(id);
  }

  // Vowelless words (3+ consonants, no aeiou/y) — abbreviations/tool names: pnpm, npm, ssh, grpc
  const vowelless = text.match(/\b[bcdfghjklmnpqrstvwxz]{3,}\b/gi);
  if (vowelless) {
    for (const w of vowelless) entities.add(w.toLowerCase());
  }

  // Numbers with context
  const numbersCtx = text.match(/\b\d+(?:\.\d+)?\s*(?:seconds?|retries?|attempts?|MB|GB|TB|KB|ms|minutes?|hours?|days?|bytes?|workers?|threads?|nodes?|replicas?|instances?|users?|requests?|errors?|percent|%)\b/gi);
  if (numbersCtx) {
    for (const n of numbersCtx) entities.add(n.trim());
  }

  // Cap at 10
  return Array.from(entities).slice(0, 10);
}

function splitCodeAndProse(text: string): Array<{ type: 'prose' | 'code'; content: string }> {
  const segments: Array<{ type: 'prose' | 'code'; content: string }> = [];
  const fenceRe = /^[ ]{0,3}```[^\n]*\n[\s\S]*?\n\s*```/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    const prose = text.slice(lastIndex, match.index).trim();
    if (prose) {
      segments.push({ type: 'prose', content: prose });
    }
    segments.push({ type: 'code', content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  const trailing = text.slice(lastIndex).trim();
  if (trailing) {
    segments.push({ type: 'prose', content: trailing });
  }

  return segments;
}

function isValidJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function contentLength(msg: Message): number {
  return typeof msg.content === 'string' ? msg.content.length : 0;
}

/** Estimate token count for a single message (~3.5 chars/token). */
function estimateTokens(msg: Message): number {
  return Math.ceil(contentLength(msg) / 3.5);
}

// ---------------------------------------------------------------------------
// Shared helpers extracted for sync / async reuse
// ---------------------------------------------------------------------------

type Classified = { msg: Message; preserved: boolean; codeSplit?: boolean; dedup?: DedupAnnotation };

/** Build a compressed message with _uc_original provenance metadata. */
function buildCompressedMessage(
  base: Message,
  ids: string[],
  summaryContent: string,
  sourceVersion: number,
  verbatim: Record<string, Message>,
  sourceMessages: Message[],
): Message {
  const summaryId = makeSummaryId(ids);
  const parents = collectParentIds(sourceMessages);
  for (const m of sourceMessages) { verbatim[m.id] = m; }
  return {
    ...base,
    content: summaryContent,
    metadata: {
      ...(base.metadata ?? {}),
      _uc_original: {
        ids,
        summary_id: summaryId,
        ...(parents.length > 0 ? { parent_ids: parents } : {}),
        version: sourceVersion,
      },
    },
  };
}

/** Wrap summary text with entity suffix and optional merge count. */
function formatSummary(
  summaryText: string,
  rawText: string,
  mergeCount?: number,
  skipEntities?: boolean,
): string {
  const entitySuffix = skipEntities
    ? ''
    : (() => { const e = extractEntities(rawText); return e.length > 0 ? ` | entities: ${e.join(', ')}` : ''; })();
  const mergeSuffix = mergeCount && mergeCount > 1 ? ` (${mergeCount} messages merged)` : '';
  return `[summary: ${summaryText}${mergeSuffix}${entitySuffix}]`;
}

/** Collect consecutive non-preserved, non-codeSplit, non-dedup messages with the same role. */
function collectGroup(
  classified: Classified[],
  startIdx: number,
): { group: Classified[]; nextIdx: number } {
  const group: Classified[] = [];
  const role = classified[startIdx].msg.role;
  let i = startIdx;
  while (i < classified.length && !classified[i].preserved && !classified[i].codeSplit && !classified[i].dedup && classified[i].msg.role === role) {
    group.push(classified[i]);
    i++;
  }
  return { group, nextIdx: i };
}

// Hard T0 reasons: genuinely structural content that can't be summarized.
// Soft T0 reasons (file_path, url, version_number, etc.): incidental
// references in prose — entities capture them, prose is still compressible.
const HARD_T0_REASONS = new Set([
  'code_fence', 'indented_code', 'json_structure', 'yaml_structure',
  'high_special_char_ratio', 'high_line_length_variance', 'api_key',
  'latex_math', 'unicode_math', 'sql_content', 'verse_pattern',
]);

function classifyAll(
  messages: Message[],
  preserveRoles: Set<string>,
  recencyWindow: number,
  dedupAnnotations?: Map<number, DedupAnnotation>,
): Classified[] {
  const recencyStart = Math.max(0, messages.length - recencyWindow);

  return messages.map((msg, idx) => {
    const content = typeof msg.content === 'string' ? msg.content : '';

    if (msg.role && preserveRoles.has(msg.role)) {
      return { msg, preserved: true };
    }
    if (recencyWindow > 0 && idx >= recencyStart) {
      return { msg, preserved: true };
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return { msg, preserved: true };
    }
    if (content.length < 120) {
      return { msg, preserved: true };
    }
    if (content.startsWith('[summary:')) {
      return { msg, preserved: true };
    }
    if (dedupAnnotations?.has(idx)) {
      return { msg, preserved: false, dedup: dedupAnnotations.get(idx)! };
    }
    if (content.includes('```')) {
      const segments = splitCodeAndProse(content);
      const totalProse = segments
        .filter(s => s.type === 'prose')
        .reduce((sum, s) => sum + s.content.length, 0);
      if (totalProse >= 80) {
        return { msg, preserved: false, codeSplit: true };
      }
      return { msg, preserved: true };
    }
    if (content) {
      const cls = classifyMessage(content);
      if (cls.decision === 'T0') {
        const hasHardReason = cls.reasons.some(r => HARD_T0_REASONS.has(r));
        if (hasHardReason) {
          return { msg, preserved: true };
        }
        // Soft T0 only — allow compression, entities will capture references
      }
    }
    if (content && isValidJson(content)) {
      return { msg, preserved: true };
    }

    return { msg, preserved: false };
  });
}

function computeStats(
  originalMessages: Message[],
  resultMessages: Message[],
  messagesCompressed: number,
  messagesPreserved: number,
  sourceVersion: number,
  messagesDeduped?: number,
  messagesFuzzyDeduped?: number,
): CompressResult['compression'] {
  const originalTotalChars = originalMessages.reduce((sum, m) => sum + contentLength(m), 0);
  const compressedTotalChars = resultMessages.reduce((sum, m) => sum + contentLength(m), 0);
  const totalCompressed = messagesCompressed + (messagesDeduped ?? 0);
  const ratio = compressedTotalChars > 0 ? originalTotalChars / compressedTotalChars : 1;

  const originalTotalTokens = originalMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
  const compressedTotalTokens = resultMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
  const tokenRatio = compressedTotalTokens > 0 ? originalTotalTokens / compressedTotalTokens : 1;

  return {
    original_version: sourceVersion,
    ratio: totalCompressed === 0 ? 1 : ratio,
    token_ratio: totalCompressed === 0 ? 1 : tokenRatio,
    messages_compressed: messagesCompressed,
    messages_preserved: messagesPreserved,
    ...(messagesDeduped && messagesDeduped > 0 ? { messages_deduped: messagesDeduped } : {}),
    ...(messagesFuzzyDeduped && messagesFuzzyDeduped > 0 ? { messages_fuzzy_deduped: messagesFuzzyDeduped } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sync compression (internal)
// ---------------------------------------------------------------------------

function compressSync(
  messages: Message[],
  options: CompressOptions = {},
): CompressResult {
  const sourceVersion = options.sourceVersion ?? 0;

  if (messages.length === 0) {
    return {
      messages: [],
      compression: {
        original_version: sourceVersion,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: 0,
      },
      verbatim: {},
    };
  }

  const preserveRoles = new Set(options.preserve ?? ['system']);
  const recencyWindow = options.recencyWindow ?? 4;
  const recencyStart = Math.max(0, messages.length - (recencyWindow > 0 ? recencyWindow : 0));
  let dedupAnnotations = (options.dedup ?? true)
    ? analyzeDuplicates(messages, recencyStart, preserveRoles)
    : undefined;

  if (options.fuzzyDedup) {
    const fuzzyAnnotations = analyzeFuzzyDuplicates(
      messages, recencyStart, preserveRoles,
      dedupAnnotations ?? new Map(),
      options.fuzzyThreshold ?? 0.85,
    );
    if (fuzzyAnnotations.size > 0) {
      if (!dedupAnnotations) dedupAnnotations = new Map();
      for (const [idx, ann] of fuzzyAnnotations) {
        dedupAnnotations.set(idx, ann);
      }
    }
  }

  const classified = classifyAll(messages, preserveRoles, recencyWindow, dedupAnnotations);

  const result: Message[] = [];
  const verbatim: Record<string, Message> = {};
  let messagesCompressed = 0;
  let messagesPreserved = 0;
  let messagesDeduped = 0;
  let messagesFuzzyDeduped = 0;
  let i = 0;

  while (i < classified.length) {
    const { msg, preserved } = classified[i];

    if (preserved) {
      result.push(msg);
      messagesPreserved++;
      i++;
      continue;
    }

    // Dedup: replace earlier duplicate/near-duplicate with compact reference
    if (classified[i].dedup) {
      const annotation = classified[i].dedup!;
      const tag = annotation.similarity != null
        ? `[uc:near-dup — ${annotation.contentLength} chars, ~${Math.round(annotation.similarity * 100)}% match, see later message]`
        : `[uc:dup — ${annotation.contentLength} chars, see later message]`;
      result.push(buildCompressedMessage(msg, [msg.id], tag, sourceVersion, verbatim, [msg]));
      messagesCompressed++;
      if (annotation.similarity != null) {
        messagesFuzzyDeduped++;
      } else {
        messagesDeduped++;
      }
      i++;
      continue;
    }

    // Code-split: extract fences verbatim, summarize surrounding prose
    if (classified[i].codeSplit) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const segments = splitCodeAndProse(content);
      const proseText = segments.filter(s => s.type === 'prose').map(s => s.content).join(' ');
      const codeFences = segments.filter(s => s.type === 'code').map(s => s.content);
      const proseBudget = proseText.length < 600 ? 200 : 400;
      const summaryText = summarize(proseText, proseBudget);
      const compressed = `${formatSummary(summaryText, proseText, undefined, true)}\n\n${codeFences.join('\n\n')}`;

      if (compressed.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        i++;
        continue;
      }

      result.push(buildCompressedMessage(msg, [msg.id], compressed, sourceVersion, verbatim, [msg]));
      messagesCompressed++;
      i++;
      continue;
    }

    // Collect consecutive non-preserved messages with the SAME role
    const { group, nextIdx } = collectGroup(classified, i);
    i = nextIdx;

    const allContent = group.map(g => typeof g.msg.content === 'string' ? g.msg.content : '').join(' ');
    const contentBudget = allContent.length < 600 ? 200 : 400;
    const summaryText = isStructuredOutput(allContent)
      ? summarizeStructured(allContent, contentBudget)
      : summarize(allContent, contentBudget);

    if (group.length > 1) {
      let summary = formatSummary(summaryText, allContent, group.length);
      const combinedLength = group.reduce((sum, g) => sum + contentLength(g.msg), 0);
      if (summary.length >= combinedLength) {
        summary = formatSummary(summaryText, allContent, group.length, true);
      }

      if (summary.length >= combinedLength) {
        for (const g of group) {
          result.push(g.msg);
          messagesPreserved++;
        }
      } else {
        const sourceMsgs = group.map(g => g.msg);
        const mergeIds = sourceMsgs.map(m => m.id);
        const base: Message = { id: sourceMsgs[0].id, index: sourceMsgs[0].index, role: sourceMsgs[0].role, metadata: sourceMsgs[0].metadata } as Message;
        result.push(buildCompressedMessage(base, mergeIds, summary, sourceVersion, verbatim, sourceMsgs));
        messagesCompressed += group.length;
      }
    } else {
      const single = group[0].msg;
      const content = typeof single.content === 'string' ? single.content : '';
      let summary = formatSummary(summaryText, allContent);
      if (summary.length >= content.length) {
        summary = formatSummary(summaryText, allContent, undefined, true);
      }

      if (summary.length >= content.length) {
        result.push(single);
        messagesPreserved++;
      } else {
        result.push(buildCompressedMessage(single, [single.id], summary, sourceVersion, verbatim, [single]));
        messagesCompressed++;
      }
    }
  }

  return {
    messages: result,
    compression: computeStats(messages, result, messagesCompressed, messagesPreserved, sourceVersion, messagesDeduped, messagesFuzzyDeduped),
    verbatim,
  };
}

// ---------------------------------------------------------------------------
// Async compression (internal, LLM summarizer support)
// ---------------------------------------------------------------------------

async function withFallback(text: string, userSummarizer?: Summarizer, maxBudget?: number): Promise<string> {
  if (userSummarizer) {
    try {
      const result = await userSummarizer(text);
      if (typeof result === 'string' && result.length > 0 && result.length < text.length) return result;
    } catch { /* fall through to deterministic */ }
  }
  return summarize(text, maxBudget);
}

async function compressAsync(
  messages: Message[],
  options: CompressOptions = {},
): Promise<CompressResult> {
  const sourceVersion = options.sourceVersion ?? 0;
  const userSummarizer = options.summarizer;

  if (messages.length === 0) {
    return {
      messages: [],
      compression: {
        original_version: sourceVersion,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: 0,
      },
      verbatim: {},
    };
  }

  const preserveRoles = new Set(options.preserve ?? ['system']);
  const recencyWindow = options.recencyWindow ?? 4;
  const recencyStart = Math.max(0, messages.length - (recencyWindow > 0 ? recencyWindow : 0));
  let dedupAnnotations = (options.dedup ?? true)
    ? analyzeDuplicates(messages, recencyStart, preserveRoles)
    : undefined;

  if (options.fuzzyDedup) {
    const fuzzyAnnotations = analyzeFuzzyDuplicates(
      messages, recencyStart, preserveRoles,
      dedupAnnotations ?? new Map(),
      options.fuzzyThreshold ?? 0.85,
    );
    if (fuzzyAnnotations.size > 0) {
      if (!dedupAnnotations) dedupAnnotations = new Map();
      for (const [idx, ann] of fuzzyAnnotations) {
        dedupAnnotations.set(idx, ann);
      }
    }
  }

  const classified = classifyAll(messages, preserveRoles, recencyWindow, dedupAnnotations);

  const result: Message[] = [];
  const verbatim: Record<string, Message> = {};
  let messagesCompressed = 0;
  let messagesPreserved = 0;
  let messagesDeduped = 0;
  let messagesFuzzyDeduped = 0;
  let i = 0;

  while (i < classified.length) {
    const { msg, preserved } = classified[i];

    if (preserved) {
      result.push(msg);
      messagesPreserved++;
      i++;
      continue;
    }

    // Dedup: replace earlier duplicate/near-duplicate with compact reference
    if (classified[i].dedup) {
      const annotation = classified[i].dedup!;
      const tag = annotation.similarity != null
        ? `[uc:near-dup — ${annotation.contentLength} chars, ~${Math.round(annotation.similarity * 100)}% match, see later message]`
        : `[uc:dup — ${annotation.contentLength} chars, see later message]`;
      result.push(buildCompressedMessage(msg, [msg.id], tag, sourceVersion, verbatim, [msg]));
      messagesCompressed++;
      if (annotation.similarity != null) {
        messagesFuzzyDeduped++;
      } else {
        messagesDeduped++;
      }
      i++;
      continue;
    }

    // Code-split: extract fences verbatim, summarize surrounding prose
    if (classified[i].codeSplit) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const segments = splitCodeAndProse(content);
      const proseText = segments.filter(s => s.type === 'prose').map(s => s.content).join(' ');
      const codeFences = segments.filter(s => s.type === 'code').map(s => s.content);
      const proseBudget = proseText.length < 600 ? 200 : 400;
      const summaryText = await withFallback(proseText, userSummarizer, proseBudget);
      const compressed = `${formatSummary(summaryText, proseText, undefined, true)}\n\n${codeFences.join('\n\n')}`;

      if (compressed.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        i++;
        continue;
      }

      result.push(buildCompressedMessage(msg, [msg.id], compressed, sourceVersion, verbatim, [msg]));
      messagesCompressed++;
      i++;
      continue;
    }

    // Collect consecutive non-preserved messages with the SAME role
    const { group, nextIdx } = collectGroup(classified, i);
    i = nextIdx;

    const allContent = group.map(g => typeof g.msg.content === 'string' ? g.msg.content : '').join(' ');
    const contentBudget = allContent.length < 600 ? 200 : 400;
    const summaryText = isStructuredOutput(allContent)
      ? summarizeStructured(allContent, contentBudget)
      : await withFallback(allContent, userSummarizer, contentBudget);

    if (group.length > 1) {
      let summary = formatSummary(summaryText, allContent, group.length);
      const combinedLength = group.reduce((sum, g) => sum + contentLength(g.msg), 0);
      if (summary.length >= combinedLength) {
        summary = formatSummary(summaryText, allContent, group.length, true);
      }

      if (summary.length >= combinedLength) {
        for (const g of group) {
          result.push(g.msg);
          messagesPreserved++;
        }
      } else {
        const sourceMsgs = group.map(g => g.msg);
        const mergeIds = sourceMsgs.map(m => m.id);
        const base: Message = { id: sourceMsgs[0].id, index: sourceMsgs[0].index, role: sourceMsgs[0].role, metadata: sourceMsgs[0].metadata } as Message;
        result.push(buildCompressedMessage(base, mergeIds, summary, sourceVersion, verbatim, sourceMsgs));
        messagesCompressed += group.length;
      }
    } else {
      const single = group[0].msg;
      const content = typeof single.content === 'string' ? single.content : '';
      let summary = formatSummary(summaryText, allContent);
      if (summary.length >= content.length) {
        summary = formatSummary(summaryText, allContent, undefined, true);
      }

      if (summary.length >= content.length) {
        result.push(single);
        messagesPreserved++;
      } else {
        result.push(buildCompressedMessage(single, [single.id], summary, sourceVersion, verbatim, [single]));
        messagesCompressed++;
      }
    }
  }

  return {
    messages: result,
    compression: computeStats(messages, result, messagesCompressed, messagesPreserved, sourceVersion, messagesDeduped, messagesFuzzyDeduped),
    verbatim,
  };
}

// ---------------------------------------------------------------------------
// Token budget helpers (absorbed from compressToFit)
// ---------------------------------------------------------------------------

function estimateTokensTotal(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

function budgetFastPath(
  messages: Message[],
  tokenBudget: number,
  sourceVersion: number,
): CompressResult | undefined {
  const totalTokens = estimateTokensTotal(messages);
  if (totalTokens <= tokenBudget) {
    return {
      messages,
      compression: {
        original_version: sourceVersion,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: messages.length,
      },
      verbatim: {},
      fits: true,
      tokenCount: totalTokens,
      recencyWindow: messages.length,
    };
  }
  return undefined;
}

function addBudgetFields(cr: CompressResult, tokenBudget: number, recencyWindow: number): CompressResult {
  const tokens = estimateTokensTotal(cr.messages);
  return { ...cr, fits: tokens <= tokenBudget, tokenCount: tokens, recencyWindow };
}

function compressSyncWithBudget(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): CompressResult {
  const minRw = options.minRecencyWindow ?? 0;
  const sourceVersion = options.sourceVersion ?? 0;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion);
  if (fast) return fast;

  let lo = minRw;
  let hi = messages.length - 1;
  let lastResult: CompressResult | undefined;
  let lastRw = -1;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cr = compressSync(messages, { ...options, recencyWindow: mid, summarizer: undefined, tokenBudget: undefined });
    lastResult = addBudgetFields(cr, tokenBudget, mid);
    lastRw = mid;

    if (lastResult.fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lastRw === lo && lastResult) return lastResult;

  const cr = compressSync(messages, { ...options, recencyWindow: lo, summarizer: undefined, tokenBudget: undefined });
  return addBudgetFields(cr, tokenBudget, lo);
}

async function compressAsyncWithBudget(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): Promise<CompressResult> {
  const minRw = options.minRecencyWindow ?? 0;
  const sourceVersion = options.sourceVersion ?? 0;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion);
  if (fast) return fast;

  let lo = minRw;
  let hi = messages.length - 1;
  let lastResult: CompressResult | undefined;
  let lastRw = -1;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cr = await compressAsync(messages, { ...options, recencyWindow: mid, tokenBudget: undefined });
    lastResult = addBudgetFields(cr, tokenBudget, mid);
    lastRw = mid;

    if (lastResult.fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lastRw === lo && lastResult) return lastResult;

  const cr = await compressAsync(messages, { ...options, recencyWindow: lo, tokenBudget: undefined });
  return addBudgetFields(cr, tokenBudget, lo);
}

// ---------------------------------------------------------------------------
// Public API: compress() with overloads
// ---------------------------------------------------------------------------

/**
 * Compress a message array. Sync by default; async when a `summarizer` is provided.
 *
 * The caller MUST persist `messages` and `verbatim` atomically.
 * Partial writes (e.g. storing compressed messages without their
 * verbatim originals) will cause data loss that `uncompress()`
 * surfaces via `missing_ids`.
 */
export function compress(
  messages: Message[],
  options?: CompressOptions,
): CompressResult;
export function compress(
  messages: Message[],
  options: CompressOptions & { summarizer: Summarizer },
): Promise<CompressResult>;
export function compress(
  messages: Message[],
  options: CompressOptions = {},
): CompressResult | Promise<CompressResult> {
  const hasSummarizer = !!options.summarizer;
  const hasBudget = options.tokenBudget != null;

  if (hasSummarizer) {
    // Async paths
    if (hasBudget) {
      return compressAsyncWithBudget(messages, options.tokenBudget!, options);
    }
    return compressAsync(messages, options);
  }

  // Sync paths
  if (hasBudget) {
    return compressSyncWithBudget(messages, options.tokenBudget!, options);
  }
  return compressSync(messages, options);
}
