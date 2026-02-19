import { classifyMessage } from './classify.js';
import type { CompressOptions, CompressResult, Message } from './types.js';

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?\n]+[.!?]?/);
  return match ? match[0].trim() : text.slice(0, 80).trim();
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

  // Step 1: classify each message as preserved or compressible
  const classified: Array<{ msg: Message; preserved: boolean }> = messages.map(msg => {
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Rule 1: role in preserve list
    if (msg.role && preserveRoles.has(msg.role)) {
      return { msg, preserved: true };
    }

    // Rule 2: tool/function messages or messages with tool_calls
    if (msg.role === 'tool' || msg.role === 'function' || (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)) {
      return { msg, preserved: true };
    }

    // Rule 3: short content
    if (content.length < 120) {
      return { msg, preserved: true };
    }

    // Rule 4: VBC classifies as T0
    if (content && classifyMessage(content).decision === 'T0') {
      return { msg, preserved: true };
    }

    // Rule 5: valid JSON
    if (content && isValidJson(content)) {
      return { msg, preserved: true };
    }

    return { msg, preserved: false };
  });

  // Step 2: compress non-preserved messages
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

    // Collect consecutive non-preserved messages for merging
    const group: Array<{ msg: Message; preserved: boolean }> = [];
    while (i < classified.length && !classified[i].preserved) {
      group.push(classified[i]);
      i++;
    }

    if (group.length > 1) {
      // Consecutive turn merging
      const firstContent = typeof group[0].msg.content === 'string' ? group[0].msg.content : '';
      const summary = `[summary: ${firstSentence(firstContent)}... (${group.length} messages merged)]`;
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
      // Single non-preserved message: large prose compression
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 800) {
        const summary = `[summary: ${firstSentence(content)}]`;
        const compressedMsg: Message = {
          ...msg,
          content: summary,
          metadata: {
            ...(msg.metadata ?? {}),
            _uc_original: {
              id: msg.id,
              version: 0,
            },
          },
        };
        result.push(compressedMsg);
        messagesCompressed++;
      } else {
        // Not large enough for prose compression — still merge as single
        const summary = `[summary: ${firstSentence(content)}... (1 messages merged)]`;
        const compressedMsg: Message = {
          ...msg,
          content: summary,
          metadata: {
            ...(msg.metadata ?? {}),
            _uc_original: {
              ids: [msg.id],
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
