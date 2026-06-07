// =============================================================================
// @ultracontext/mirror — fs-first Mutagen mirror orchestration. Public surface:
// config i/o + RemoteSpec, the pure mutagen parsers + command runner, and the
// start/stop/status/reset/list orchestration with source add/list.
// =============================================================================

// config: ~/.ultracontext mirror config + derived helpers
export {
    configDir,
    configPath,
    expandHome,
    loadConfig,
    saveConfig,
    parseRemoteSpec,
    isLocalConfig,
    upsertSource,
    removeSource,
    setSourceEnabled,
    findSource,
    enabledSources,
    validateSourceName,
    mutagenSessionName,
    remoteEndpoint,
    defaultHostId,
    type Config,
    type Source,
    type RemoteSpec,
    type LoadOptions,
} from './config';

// ignores: the global + per-source `.ultracontextignore` subsystem
export {
    ensureIgnoreFiles,
    ignorePath,
    sourceIgnorePath,
    collectIgnorePatterns,
    type IgnoreDeps,
} from './ignores';

// mutagen: pure stdout parsers + the injectable command runner
export {
    parseMutagenSessions,
    mutagenSessionStatus,
    mutagenSessionExists,
    ownedMutagenSessionNames,
    spawnRunner,
    type SessionInfo,
    type CommandRunner,
    type CommandResult,
} from './mutagen';

// mirror: orchestration over the mutagen binary
export {
    mirrorStart,
    mirrorStop,
    mirrorStatus,
    mirrorList,
    mirrorReset,
    sourceAdd,
    sourceList,
    sourceRemove,
    sourceSetEnabled,
    type MirrorDeps,
    type MirrorListEntry,
    type SourceRemoveOptions,
} from './mirror';
