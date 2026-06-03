export function generatePublicId(type: 'context' | 'msg'): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return type === 'context' ? `ctx_${hex}` : `msg_${hex}`;
}

// an event id: 'evt_' + 24 crypto-random hex chars (12 bytes)
export function generateEventId(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `evt_${hex}`;
}
