import { classifyMessage } from './classify.js';
import type { CompressOptions, CompressResult, Message } from './types.js';

/**
 * Deterministic summary ID from sorted source message IDs.
 * Uses djb2 to avoid a crypto dependency; collisions are acceptable
 * because the ID is advisory provenance, not a security primitive.
 */
function makeSummaryId(ids: string[]): string {
  const key = ids.slice().sort().join('\0');
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

function summarize(text: string): string {
  const sentences = text.match(/[^.!?\n]+[.!?]+/g);

  if (!sentences || sentences.length === 0) {
    return text.slice(0, 200).trim();
  }

  // Skip leading filler sentences
  let firstIdx = 0;
  while (firstIdx < sentences.length && FILLER_RE.test(sentences[firstIdx].trim())) {
    firstIdx++;
  }
  // If all sentences are filler, fall back to the first one
  if (firstIdx >= sentences.length) firstIdx = 0;

  const first = sentences[firstIdx].trim();
  const last = sentences[sentences.length - 1].trim();

  let result: string;
  if (firstIdx === sentences.length - 1 || first === last) {
    result = first;
  } else {
    result = `${first} ... ${last}`;
  }

  if (result.length > 200) {
    return result.slice(0, 197) + '...';
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
  const fenceRe = /^```[^\n]*\n[\s\S]*?\n```/gm;
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

function estimateTokens(msg: Message): number {
  return Math.ceil(contentLength(msg) / 3.5);
}

/**
 * Compress a message array, returning compressed messages, stats, and
 * a verbatim map of every original that was replaced.
 *
 * The caller MUST persist `messages` and `verbatim` atomically.
 * Partial writes (e.g. storing compressed messages without their
 * verbatim originals) will cause data loss that `expandMessages()`
 * surfaces via `missing_ids`.
 */
export function compressMessages(
  messages: Message[],
  options: CompressOptions = {},
): CompressResult {
  if (options.mode === 'lossy') {
    throw new Error('Lossy compression is not yet implemented (501)');
  }

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
  const originalTotalChars = messages.reduce((sum, m) => sum + contentLength(m), 0);
  const recencyWindow = options.recencyWindow ?? 4;
  const recencyStart = Math.max(0, messages.length - recencyWindow);

  // Step 1: classify each message as preserved or compressible
  const classified: Array<{ msg: Message; preserved: boolean; codeSplit?: boolean }> = messages.map((msg, idx) => {
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Rule 1: role in preserve list
    if (msg.role && preserveRoles.has(msg.role)) {
      return { msg, preserved: true };
    }

    // Rule 2: recency protection
    if (recencyWindow > 0 && idx >= recencyStart) {
      return { msg, preserved: true };
    }

    // Rule 3: messages with tool_calls (assistant's function call request)
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return { msg, preserved: true };
    }

    // Rule 4: short content
    if (content.length < 120) {
      return { msg, preserved: true };
    }

    // Rule 5: already-compressed content — don't double-compress
    if (content.startsWith('[summary:')) {
      return { msg, preserved: true };
    }

    // Rule 6: code fence splitting — extract fences verbatim, summarize prose
    if (content.includes('```')) {
      const segments = splitCodeAndProse(content);
      const totalProse = segments
        .filter(s => s.type === 'prose')
        .reduce((sum, s) => sum + s.content.length, 0);
      // 200, not 120: the [summary: ... | entities: ...] bracket + \n\n separators
      // add ~80-100 chars of overhead; prose under 200 chars yields negligible or
      // negative savings after that overhead is applied.
      if (totalProse >= 200) {
        return { msg, preserved: false, codeSplit: true };
      }
      return { msg, preserved: true };
    }

    // Rule 7: VBC classifies as T0
    if (content && classifyMessage(content).decision === 'T0') {
      return { msg, preserved: true };
    }

    // Rule 8: valid JSON
    if (content && isValidJson(content)) {
      return { msg, preserved: true };
    }

    return { msg, preserved: false };
  });

  // Step 2: compress non-preserved messages (respecting role boundaries)
  const result: Message[] = [];
  const verbatim: Record<string, Message> = {};
  let messagesCompressed = 0;
  let messagesPreserved = 0;
  let i = 0;

  while (i < classified.length) {
    const { msg, preserved } = classified[i];

    if (preserved) {
      result.push(msg);
      messagesPreserved++;
      i++;
      continue;
    }

    // Code-split: extract fences verbatim, summarize surrounding prose
    if (classified[i].codeSplit) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const segments = splitCodeAndProse(content);
      const proseText = segments.filter(s => s.type === 'prose').map(s => s.content).join(' ');
      const codeFences = segments.filter(s => s.type === 'code').map(s => s.content);
      const summaryText = summarize(proseText);
      const entities = extractEntities(proseText);
      const entitySuffix = entities.length > 0 ? ` | entities: ${entities.join(', ')}` : '';
      const compressed = `[summary: ${summaryText}${entitySuffix}]\n\n${codeFences.join('\n\n')}`;

      // Guard: skip compression if output >= original
      if (compressed.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        i++;
        continue;
      }

      const csIds = [msg.id];
      const csSummaryId = makeSummaryId(csIds);
      const csParents = collectParentIds([msg]);
      verbatim[msg.id] = msg;
      result.push({
        ...msg,
        content: compressed,
        metadata: {
          ...(msg.metadata ?? {}),
          _uc_original: {
            ids: csIds,
            summary_id: csSummaryId,
            ...(csParents.length > 0 ? { parent_ids: csParents } : {}),
            version: sourceVersion,
          },
        },
      });
      messagesCompressed++;
      i++;
      continue;
    }

    // Collect consecutive non-preserved messages with the SAME role
    const group: Array<{ msg: Message; preserved: boolean }> = [];
    const groupRole = classified[i].msg.role;
    while (i < classified.length && !classified[i].preserved && !classified[i].codeSplit && classified[i].msg.role === groupRole) {
      group.push(classified[i]);
      i++;
    }

    // Build summary from group content
    const allContent = group.map(g => typeof g.msg.content === 'string' ? g.msg.content : '').join(' ');
    const summaryText = summarize(allContent);
    const entities = extractEntities(allContent);
    const entitySuffix = entities.length > 0 ? ` | entities: ${entities.join(', ')}` : '';

    if (group.length > 1) {
      // Consecutive same-role merging
      const summary = `[summary: ${summaryText} (${group.length} messages merged)${entitySuffix}]`;
      const combinedLength = group.reduce((sum, g) => sum + contentLength(g.msg), 0);

      if (summary.length >= combinedLength) {
        for (const g of group) {
          result.push(g.msg);
          messagesPreserved++;
        }
      } else {
        const mergeIds = group.map(g => g.msg.id);
        const mergeSummaryId = makeSummaryId(mergeIds);
        const mergeParents = collectParentIds(group.map(g => g.msg));
        for (const g of group) { verbatim[g.msg.id] = g.msg; }
        const mergedMsg: Message = {
          id: group[0].msg.id,
          index: group[0].msg.index,
          role: group[0].msg.role,
          content: summary,
          metadata: {
            ...(group[0].msg.metadata ?? {}),
            _uc_original: {
              ids: mergeIds,
              summary_id: mergeSummaryId,
              ...(mergeParents.length > 0 ? { parent_ids: mergeParents } : {}),
              version: sourceVersion,
            },
          },
        };
        result.push(mergedMsg);
        messagesCompressed += group.length;
      }
    } else {
      // Single non-preserved message
      const single = group[0].msg;
      const content = typeof single.content === 'string' ? single.content : '';
      const summary = `[summary: ${summaryText}${entitySuffix}]`;

      if (summary.length >= content.length) {
        result.push(single);
        messagesPreserved++;
      } else {
        const singleIds = [single.id];
        const singleSummaryId = makeSummaryId(singleIds);
        const singleParents = collectParentIds([single]);
        verbatim[single.id] = single;
        result.push({
          ...single,
          content: summary,
          metadata: {
            ...(single.metadata ?? {}),
            _uc_original: {
              ids: singleIds,
              summary_id: singleSummaryId,
              ...(singleParents.length > 0 ? { parent_ids: singleParents } : {}),
              version: sourceVersion,
            },
          },
        });
        messagesCompressed++;
      }
    }
  }

  const compressedTotalChars = result.reduce((sum, m) => sum + contentLength(m), 0);
  const ratio = compressedTotalChars > 0 ? originalTotalChars / compressedTotalChars : 1;

  const originalTotalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  const compressedTotalTokens = result.reduce((sum, m) => sum + estimateTokens(m), 0);
  const tokenRatio = compressedTotalTokens > 0 ? originalTotalTokens / compressedTotalTokens : 1;

  return {
    messages: result,
    compression: {
      original_version: sourceVersion,
      ratio: messagesCompressed === 0 ? 1 : ratio,
      token_ratio: messagesCompressed === 0 ? 1 : tokenRatio,
      messages_compressed: messagesCompressed,
      messages_preserved: messagesPreserved,
    },
    verbatim,
  };
}
