export type CompressOptions = {
  preserve?: string[];
  mode?: 'lossless' | 'lossy';
  recencyWindow?: number;
  /** Context version at the time of compression. Flows into _uc_original.version and compression.original_version. */
  sourceVersion?: number;
};

export type VerbatimMap = Record<string, Message>;

export type ExpandOptions = {
  /** Recursively expand messages whose originals are also compressed. Default: false. */
  recursive?: boolean;
};

export type ExpandResult = {
  messages: Message[];
  messages_expanded: number;
  messages_passthrough: number;
  /** IDs looked up but not found. Non-empty = data loss in the verbatim store. */
  missing_ids: string[];
};

export type CompressResult = {
  messages: Message[];
  compression: {
    original_version: number;
    ratio: number;
    messages_compressed: number;
    messages_preserved: number;
  };
  /** Original verbatim messages keyed by ID. Every compressed message's source appears here. */
  verbatim: VerbatimMap;
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
