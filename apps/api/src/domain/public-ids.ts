export function generatePublicId(type: 'context' | 'msg'): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return type === 'context' ? `ctx_${hex}` : `msg_${hex}`;
}
