// =============================================================================
// MESSAGE VIEW — the response shape of a single message (content + id/index/meta)
// =============================================================================

// content fields are spread alongside the generated id, ordinal index, and metadata
export type MessageView = Record<string, unknown> & {
    id: string;
    index: number;
    metadata: Record<string, unknown>;
};
