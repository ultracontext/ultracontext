const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function toBase62(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        result += BASE62[bytes[i] % 62];
    }
    return result;
}

export function generateKey(env: 'live' | 'test' = 'live') {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `uc_${env}_${toBase62(bytes)}`;
}

export async function hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
