// =============================================================================
// @ultracontext/sync — fs-first Mutagen sync orchestration. Public surface:
// config i/o + RemoteSpec, the pure mutagen parsers + command runner, and the
// start/stop/status/reset/list orchestration with source add/list.
// =============================================================================

// config: ~/.ultracontext sync config + derived helpers
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
} from './config';

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

// sync: orchestration over the mutagen binary
export {
    syncStart,
    syncStop,
    syncStatus,
    syncList,
    syncReset,
    sourceAdd,
    sourceList,
    type SyncDeps,
    type SyncListEntry,
} from './sync';
