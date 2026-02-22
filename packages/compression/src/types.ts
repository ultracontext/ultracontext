export type Summarizer = (text: string) => string | Promise<string>;

export type CreateSummarizerOptions = {
  /** Maximum tokens for the LLM response. Default: 300. */
  maxResponseTokens?: number;
  /** Domain-specific instructions prepended to the built-in rules. */
  systemPrompt?: string;
  /** Summarization mode. 'normal' (default) = concise prose, 'aggressive' = terse bullet points at half token budget. */
  mode?: 'normal' | 'aggressive';
  /** Domain-specific terms appended to the built-in preserve list. */
  preserveTerms?: string[];
};

export type CompressOptions = {
  preserve?: string[];
  recencyWindow?: number;
  /** Context version at the time of compression. Flows into _uc_original.version and compression.original_version. */
  sourceVersion?: number;
  /** LLM-powered summarizer. When provided, compress() returns a Promise. */
  summarizer?: Summarizer;
  /** Target token budget. When set, compress binary-searches recencyWindow to fit. */
  tokenBudget?: number;
  /** Minimum recencyWindow when using tokenBudget. Default: 0. */
  minRecencyWindow?: number;
};

export type VerbatimMap = Record<string, Message>;

export type UncompressOptions = {
  /** Recursively expand messages whose originals are also compressed. Default: false. */
  recursive?: boolean;
};

export type UncompressResult = {
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
    /** Character-based compression ratio: original_chars / compressed_chars. >1 means savings. */
    ratio: number;
    /** Token-based compression ratio: original_tokens / compressed_tokens. >1 means savings. */
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
   * irrecoverable data loss. Use `uncompress()` after loading to
   * verify integrity — non-empty `missing_ids` indicates a partial write.
   */
  verbatim: VerbatimMap;
  /** Whether the result fits within the token budget. Present when tokenBudget is used. */
  fits?: boolean;
  /** Estimated token count of the result. Present when tokenBudget is used. */
  tokenCount?: number;
  /** The recencyWindow the binary search settled on. Present when tokenBudget is used. */
  recencyWindow?: number;
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
