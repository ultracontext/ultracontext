export type UpdateRequestInput = { id?: string; index?: number; [key: string]: unknown };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseUpdateRequestBody(body: unknown): { updates: UpdateRequestInput[]; userMetadata?: Record<string, unknown> } | { error: string } {
    if (Array.isArray(body)) {
        return { updates: body as UpdateRequestInput[] };
    }

    if (!isPlainObject(body)) {
        return { error: 'Request body must be a JSON object or array' };
    }

    const { metadata, updates, ...single } = body;

    if (metadata !== undefined && !isPlainObject(metadata)) {
        return { error: 'metadata must be an object' };
    }

    if (updates !== undefined) {
        if (!Array.isArray(updates)) return { error: 'updates must be an array' };
        return { updates: updates as UpdateRequestInput[], userMetadata: metadata as Record<string, unknown> | undefined };
    }

    return { updates: [single as UpdateRequestInput], userMetadata: metadata as Record<string, unknown> | undefined };
}
