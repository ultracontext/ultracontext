export function firstRow<T>(rows: T[]): T | null {
    return rows[0] ?? null;
}
