export type CompressOptions = {
  preserve?: string[];
  mode?: 'lossless' | 'lossy';
};

export type CompressResult = {
  messages: Message[];
  compression: {
    original_version: number;
    ratio: number;
    messages_compressed: number;
    messages_preserved: number;
  };
};

export type ClassifyResult = {
  decision: 'T0' | 'T2' | 'T3';
  confidence: number;
  reasons: string[];
};

export type Message = {
  id: string;
  index: number;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tool_calls?: unknown[];
  [key: string]: unknown;
};
