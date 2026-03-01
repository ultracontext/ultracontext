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

export type DatabaseProvider = 'postgres' | 'supabase';

export type ApiConfig =
    | {
          DATABASE_PROVIDER: 'postgres';
          DATABASE_URL: string;
          ULTRACONTEXT_ADMIN_KEY: string;
      }
    | {
          DATABASE_PROVIDER: 'supabase';
          SUPABASE_URL: string;
          SUPABASE_SERVICE_ROLE_KEY: string;
          ULTRACONTEXT_ADMIN_KEY: string;
      };

export type Auth = { apiKeyId: number; projectId: number };
