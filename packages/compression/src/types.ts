export type Summarizer = (text: string) => string | Promise<string>;

export type CompressOptions = {
  preserve?: string[];
  mode?: 'lossless' | 'lossy';
  recencyWindow?: number;
  /** Context version at the time of compression. Flows into _uc_original.version and compression.original_version. */
  sourceVersion?: number;
  /** LLM-powered summarizer. Only usable with compressMessagesAsync / compressToFitAsync. */
  summarizer?: Summarizer;
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
    token_ratio: number;
    messages_compressed: number;
    messages_preserved: number;
  };
  /**
   * Original verbatim messages keyed by ID — every compressed message's
   * source appears here.
   *
   * ATOMICITY: `messages` and `verbatim` must be persisted together in a
   * single transaction. Writing `messages` without `verbatim` causes
   * irrecoverable data loss. Use `expandMessages()` after loading to
   * verify integrity — non-empty `missing_ids` indicates a partial write.
   */
  verbatim: VerbatimMap;
};

export type ClassifyResult = {
  decision: 'T0' | 'T2' | 'T3';
  confidence: number;
  reasons: string[];
};

export type CompressToFitOptions = CompressOptions & {
  /** Minimum recencyWindow to stop at. Default: 0. */
  minRecencyWindow?: number;
};

export type CompressToFitResult = CompressResult & {
  /** Whether the result fits within the token budget. */
  fits: boolean;
  /** Final recencyWindow used. */
  recencyWindow: number;
  /** Estimated token count of the result. */
  tokenCount: number;
};

export type SearchResult = {
  /** uc_sum_XXX covering this message. */
  summaryId: string;
  /** Original message ID. */
  messageId: string;
  /** Matched message content. */
  content: string;
  /** Regex match strings. */
  matches: string[];
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
