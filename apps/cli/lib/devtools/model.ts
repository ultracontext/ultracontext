// =============================================================================
// model — the panel's data layer. Talks exclusively to the PUBLIC UltraContext
// facade (works identically over the local and remote backends). listContexts →
// newest-first summary rows; inspectContext → messages + version for the detail
// view; clearAll → the one mutation (wipe every context, the dev reset button).
// No DOM here — the UI layer renders what this returns.
// =============================================================================

import type { Version } from '@ultracontext/js';
import type { UltraContext } from '../sdk/ultracontext';

// -- types --------------------------------------------------------------------

// one row in the panel's context list
export type DevtoolsContextRow = {
    id: string;
    metadata: Record<string, unknown>;
    created_at: string;
};

// the detail view for a single context
export type DevtoolsContextDetail = {
    messages: unknown[];
    version?: number;
    versions?: Version[];
};

// -- reads --------------------------------------------------------------------

// all contexts in the project, newest first (the list the bubble opens onto)
export async function listContexts(uc: UltraContext): Promise<DevtoolsContextRow[]> {
    const res = await uc.get();
    return [...res.data].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// one context's messages + version info (the drill-down view)
export async function inspectContext(uc: UltraContext, id: string): Promise<DevtoolsContextDetail> {
    const res = await uc.get(id);
    return {
        messages: (res.data ?? []) as unknown[],
        version: res.version,
        versions: res.versions,
    };
}

// -- message display helpers ------------------------------------------------------

// best-effort role from an unknown message body — '?' when absent
export function messageRole(msg: unknown): string {
    const role = (msg as { role?: unknown } | null)?.role;
    return typeof role === 'string' && role ? role : '?';
}

// best-effort text from an unknown message body: string `content` first, then
// AI SDK-style `parts` text entries joined; undefined when nothing readable
export function messageText(msg: unknown): string | undefined {
    const m = msg as { content?: unknown; parts?: unknown } | null;
    if (typeof m?.content === 'string' && m.content) return m.content;

    if (Array.isArray(m?.parts)) {
        const text = m.parts
            .filter((p): p is { type: string; text: string } =>
                (p as { type?: unknown } | null)?.type === 'text' &&
                typeof (p as { text?: unknown }).text === 'string')
            .map((p) => p.text)
            .join('\n');
        if (text) return text;
    }

    return undefined;
}

// -- clear ----------------------------------------------------------------------

// the ONE mutation the panel offers: permanently delete EVERY context (the
// dev "zero my db" button). Returns how many were wiped.
export async function clearAll(uc: UltraContext): Promise<number> {
    const rows = await listContexts(uc);
    if (rows.length === 0) return 0;

    const res = await uc.deleteMany(rows.map((r) => r.id));
    return res.deleted_count;
}
