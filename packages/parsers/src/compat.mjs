/**
 * Agent compatibility matrix.
 *
 * Each agent entry tracks:
 *   - formatVersion: the JSONL format version our parser/writer handles
 *   - testedAgainst: CLI versions we've verified against (fixtures in tests/)
 *   - sessionDir: where the agent stores sessions locally
 *
 * The `resume` map tracks cross-agent compatibility:
 *   "can a session from source X be resumed on target Y?"
 *   Each testedPairs entry = a verified combination with fixture coverage.
 */

export const AGENT_COMPAT = {
    claude: {
        formatVersion: "v1",
        testedAgainst: ["1.0.x"],
        sessionDir: "~/.claude/projects",
    },
    codex: {
        formatVersion: "v1",
        testedAgainst: ["0.1.x"],
        sessionDir: "~/.codex/sessions",
    },
    openclaw: {
        formatVersion: "v1",
        testedAgainst: ["0.1.x"],
        sessionDir: "~/.openclaw/sessions",
    },

    // cross-agent resume compatibility
    resume: {
        "codex→claude": {
            writerVersion: "v1",
            testedPairs: [
                { source: "codex@0.1.x", target: "claude@1.0.x" },
            ],
        },
        "claude→codex": {
            writerVersion: "v1",
            testedPairs: [
                { source: "claude@1.0.x", target: "codex@0.1.x" },
            ],
        },
    },
};

// helper: check if a source→target resume pair has been tested
export function isResumePairTested(source, target) {
    const key = `${source}→${target}`;
    return (AGENT_COMPAT.resume[key]?.testedPairs?.length ?? 0) > 0;
}

// helper: get all tested agent CLI versions
export function getTestedVersions(agent) {
    return AGENT_COMPAT[agent]?.testedAgainst ?? [];
}
