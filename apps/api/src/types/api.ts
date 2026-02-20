// =============================================================================
// API RESPONSE TYPES
// =============================================================================

export type ContextResponse = {
    id: string;
    metadata: Record<string, unknown>;
    created_at: string;
    parent_id?: string;
};

export type NodeResponse = {
    id: string;
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
    parent_id?: string;
};

export type ListResponse<T> = {
    data: T[];
};

// =============================================================================
// APP CONFIGURATION TYPES
// =============================================================================

export type ApiConfig = {
    DATABASE_URL: string;
    ULTRACONTEXT_ADMIN_KEY: string;
};

export type Auth = { apiKeyId: number; projectId: number };
