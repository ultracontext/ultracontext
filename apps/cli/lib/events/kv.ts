// =============================================================================
// kv — the repeated `--count k=v` / `--label k=v` flag parsers. A driver passes
// each pair as a separate flag occurrence (see the write-a-driver guide); these
// collapse them into the envelope's counts (string→int) / labels (string→string)
// maps, rejecting a missing `=` or a non-integer count with a clear message.
// =============================================================================

// -- shared split -------------------------------------------------------------

// split one `key=value` pair on the FIRST `=` (values may contain more `=`).
// throws a clear, flag-named error when the separator is missing.
function splitPair(flag: string, pair: string): [string, string] {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`${flag} expects key=value, got: ${pair}`);
    return [pair.slice(0, eq), pair.slice(eq + 1)];
}

// -- counts -------------------------------------------------------------------

// collapse repeated `--count k=v` into a string→int map (undefined when unset)
export function parseCounts(pairs: string[] | undefined): Record<string, number> | undefined {
    if (!pairs || pairs.length === 0) return undefined;

    const out: Record<string, number> = {};
    for (const pair of pairs) {
        const [key, value] = splitPair('--count', pair);

        // counts are numeric — a non-integer is a usage error, not a silent NaN
        const n = Number(value);
        if (!Number.isInteger(n)) throw new Error(`--count value must be an integer: ${pair}`);
        out[key] = n;
    }
    return out;
}

// -- labels -------------------------------------------------------------------

// collapse repeated `--label k=v` into a string→string map (undefined when unset)
export function parseLabels(pairs: string[] | undefined): Record<string, string> | undefined {
    if (!pairs || pairs.length === 0) return undefined;

    const out: Record<string, string> = {};
    for (const pair of pairs) {
        const [key, value] = splitPair('--label', pair);
        out[key] = value;
    }
    return out;
}
