// =============================================================================
// context-id — the single context-id resolver for every targeted verb.
// Precedence: explicit <id> arg > $UC_CONTEXT env > a clear error. There is NO
// cwd default context — the product manages many contexts explicitly.
// =============================================================================

// resolve the context id a verb operates on, or throw if none is available
export function requireContextId(
    argId: string | undefined,
    env: Record<string, string | undefined> = process.env,
): string {
    // explicit arg first, then the ambient UC_CONTEXT env
    const id = argId ?? env.UC_CONTEXT;
    if (id) return id;

    // nothing to target — fail loudly with an actionable message
    throw new Error('no context — pass an id or set UC_CONTEXT');
}
