// =============================================================================
// RESULT — transport-agnostic outcome type for capability functions
// =============================================================================

// -- error codes (mapped to HTTP status by callers) ---------------------------

export type ErrorCode = 'not_found' | 'invalid_input' | 'internal';

// -- result union -------------------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string };

// -- constructors -------------------------------------------------------------

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const err = (code: ErrorCode, message: string): Result<never> => ({ ok: false, code, message });

// -- HTTP status mapping ------------------------------------------------------

export function resultStatus(code: ErrorCode): number {
    switch (code) {
        case 'not_found':
            return 404;
        case 'invalid_input':
            return 400;
        case 'internal':
            return 500;
    }
}
