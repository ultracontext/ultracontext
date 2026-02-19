import { classifyMessage } from './classify.js';
import type { CompressOptions, CompressResult, Message } from './types.js';

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
  const fenceRe = /```[\s\S]*?```/g;
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

export function compressMessages(
  messages: Message[],
  options: CompressOptions = {},
): CompressResult {
  if (options.mode === 'lossy') {
    throw new Error('Lossy compression is not yet implemented (501)');
  }

  if (messages.length === 0) {
    return {
      messages: [],
      compression: {
        original_version: 0,
        ratio: 1,
        messages_compressed: 0,
        messages_preserved: 0,
      },
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

    // Rule 3: tool/function messages or messages with tool_calls
    if (msg.role === 'tool' || msg.role === 'function' || (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)) {
      return { msg, preserved: true };
    }

    // Rule 4: short content
    if (content.length < 120) {
      return { msg, preserved: true };
    }

    // Rule 5: code fence splitting — extract fences verbatim, summarize prose
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

    // Rule 6: VBC classifies as T0
    if (content && classifyMessage(content).decision === 'T0') {
      return { msg, preserved: true };
    }

    // Rule 7: valid JSON
    if (content && isValidJson(content)) {
      return { msg, preserved: true };
    }

    return { msg, preserved: false };
  });

  // Step 2: compress non-preserved messages (respecting role boundaries)
  const result: Message[] = [];
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

      result.push({
        ...msg,
        content: compressed,
        metadata: {
          ...(msg.metadata ?? {}),
          _uc_original: {
            ids: [msg.id],
            version: 0,
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
      const mergedMsg: Message = {
        id: group[0].msg.id,
        index: group[0].msg.index,
        role: group[0].msg.role,
        content: summary,
        metadata: {
          ...(group[0].msg.metadata ?? {}),
          _uc_original: {
            ids: group.map(g => g.msg.id),
            version: 0,
          },
        },
      };
      result.push(mergedMsg);
      messagesCompressed += group.length;
    } else {
      // Single non-preserved message
      const single = group[0].msg;
      const content = typeof single.content === 'string' ? single.content : '';
      if (content.length > 800) {
        // Large prose compression
        const summary = `[summary: ${summaryText}${entitySuffix}]`;
        const compressedMsg: Message = {
          ...single,
          content: summary,
          metadata: {
            ...(single.metadata ?? {}),
            _uc_original: {
              ids: [single.id],
              version: 0,
            },
          },
        };
        result.push(compressedMsg);
        messagesCompressed++;
      } else {
        // Not large enough for prose compression — still compress as single
        const summary = `[summary: ${summaryText} (1 message merged)${entitySuffix}]`;
        const compressedMsg: Message = {
          ...single,
          content: summary,
          metadata: {
            ...(single.metadata ?? {}),
            _uc_original: {
              ids: [single.id],
              version: 0,
            },
          },
        };
        result.push(compressedMsg);
        messagesCompressed++;
      }
    }
  }

  const compressedTotalChars = result.reduce((sum, m) => sum + contentLength(m), 0);
  const ratio = compressedTotalChars > 0 ? originalTotalChars / compressedTotalChars : 1;

  return {
    messages: result,
    compression: {
      original_version: 0,
      ratio: messagesCompressed === 0 ? 1 : ratio,
      messages_compressed: messagesCompressed,
      messages_preserved: messagesPreserved,
    },
  };
}
