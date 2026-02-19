export type UltraContextConfig = {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
};

export type Version = {
    version: number;
    created_at: string;
    operation: 'create' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

export type CreateContextInput = {
    from?: string;
    version?: number;
    at?: number;
    before?: string;
    metadata?: Record<string, unknown>;
};

export type CreateContextResponse = {
    id: string;
    metadata: Record<string, unknown>;
    created_at: string;
};

export type AppendMessage = Omit<Record<string, unknown>, 'metadata'> & { metadata?: Record<string, unknown> };
export type AppendInput = AppendMessage | AppendMessage[];

export type AppendResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type GetContextInput = {
    version?: number;
    at?: number;
    before?: string;
    history?: boolean;
};

export type GetContextResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    versions?: Version[];
};

export type ListContextsResponse = {
    data: Array<{
        id: string;
        metadata: Record<string, unknown>;
        created_at: string;
    }>;
};

export type MutationOptions = {
    metadata?: Record<string, unknown>;
};

export type UpdateMessageInput =
    | ({ id: string; index?: never } & Record<string, unknown>)
    | ({ index: number; id?: never } & Record<string, unknown>);
export type UpdateInput = UpdateMessageInput | UpdateMessageInput[];

export type UpdateResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type DeleteInput = (string | number) | (string | number)[];

export type DeleteResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type CompressOptions = {
    preserve?: string[];
    mode?: 'lossless' | 'lossy';
    recencyWindow?: number;
};

export type CompressResponse = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown>; [key: string]: unknown }>;
    version: number;
    compression: {
        original_version: number;
        ratio: number;
        messages_compressed: number;
        messages_preserved: number;
    };
    verbatim: Record<string, { id: string; index: number; metadata: Record<string, unknown>; [key: string]: unknown }>;
};

export type UncompressOptions = {
    version?: number;
};

export type UncompressResponse = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown>; [key: string]: unknown }>;
    version: number;
};

export class UltraContextHttpError extends Error {
    readonly status: number;
    readonly url: string;
    readonly bodyText?: string;

    constructor(args: { status: number; url: string; bodyText?: string }) {
        super(`UltraContext request failed: ${args.status} ${args.url}`);
        this.name = 'UltraContextHttpError';
        this.status = args.status;
        this.url = args.url;
        this.bodyText = args.bodyText;
    }
}

export class UltraContext {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly fetchFn: typeof fetch;
    private readonly headers?: Record<string, string>;
    private readonly timeoutMs?: number;

    constructor(cfg: UltraContextConfig) {
        this.baseUrl = (cfg.baseUrl ?? 'https://api.ultracontext.ai').replace(/\/+$/, '');
        this.apiKey = cfg.apiKey;
        this.fetchFn = cfg.fetch ?? fetch;
        this.headers = cfg.headers;
        this.timeoutMs = cfg.timeoutMs;
    }

    async create(input: CreateContextInput = {}): Promise<CreateContextResponse> {
        return this.request<CreateContextResponse>('/contexts', {
            method: 'POST',
            body: input,
        });
    }

    async append<T = unknown>(contextId: string, input: AppendInput): Promise<AppendResponse<T>> {
        return this.request<AppendResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'POST',
            body: input,
        });
    }

    async get(options?: { limit?: number }): Promise<ListContextsResponse>;
    async get<T = unknown>(id: string, options?: GetContextInput): Promise<GetContextResponse<T>>;
    async get<T = unknown>(
        idOrOptions?: string | { limit?: number },
        options?: GetContextInput
    ): Promise<GetContextResponse<T> | ListContextsResponse> {
        if (!idOrOptions || typeof idOrOptions === 'object') {
            const params = new URLSearchParams();
            if (typeof idOrOptions === 'object' && idOrOptions.limit) params.set('limit', String(idOrOptions.limit));
            const query = params.toString();
            return this.request<ListContextsResponse>(`/contexts${query ? `?${query}` : ''}`, { method: 'GET' });
        }

        const params = new URLSearchParams();
        if (options?.version !== undefined) params.set('version', String(options.version));
        if (options?.at !== undefined) params.set('at', String(options.at));
        if (options?.before) params.set('before', options.before);
        if (options?.history) params.set('history', 'true');
        const query = params.toString();
        return this.request<GetContextResponse<T>>(`/contexts/${encodeURIComponent(idOrOptions)}${query ? `?${query}` : ''}`, { method: 'GET' });
    }

    async update<T = unknown>(contextId: string, input: UpdateInput, options?: MutationOptions): Promise<UpdateResponse<T>> {
        const body = options?.metadata
            ? { updates: Array.isArray(input) ? input : [input], metadata: options.metadata }
            : input;

        return this.request<UpdateResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'PATCH',
            body,
        });
    }

    async delete<T = unknown>(contextId: string, ids: DeleteInput, options?: MutationOptions): Promise<DeleteResponse<T>> {
        return this.request<DeleteResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'DELETE',
            body: { ids, metadata: options?.metadata },
        });
    }

    async compress(contextId: string, options?: CompressOptions): Promise<CompressResponse> {
        return this.request<CompressResponse>(`/contexts/${encodeURIComponent(contextId)}/compress`, {
            method: 'POST',
            body: options ?? {},
        });
    }

    async uncompress(contextId: string, options?: UncompressOptions): Promise<UncompressResponse> {
        return this.request<UncompressResponse>(`/contexts/${encodeURIComponent(contextId)}/uncompress`, {
            method: 'POST',
            body: options ?? {},
        });
    }

    private async request<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
        const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.headers ?? {}),
            ...(init.headers ?? {}),
        };

        let body: BodyInit | undefined;
        if (init.body !== undefined) {
            headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
            body = JSON.stringify(init.body);
        }

        const ac = this.timeoutMs ? new AbortController() : undefined;
        const timeout = this.timeoutMs ? setTimeout(() => ac?.abort(), this.timeoutMs) : undefined;

        try {
            const res = await this.fetchFn(url, {
                method: init.method,
                headers,
                body,
                signal: ac?.signal,
            });

            if (!res.ok) {
                const bodyText = await safeReadText(res);
                throw new UltraContextHttpError({ status: res.status, url, bodyText });
            }

            if (res.status === 204) return undefined as unknown as T;

            const contentType = res.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) return (await res.json()) as T;
            return (await res.text()) as unknown as T;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }
}

async function safeReadText(res: Response) {
    try {
        return await res.text();
    } catch {
        return undefined;
    }
}
