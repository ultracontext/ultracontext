//! The NFS filesystem engine bridge: maps UltraContext artifacts onto an inode tree,
//! caches that tree, buffers dirty writes, and adapts engine errors to NFS status codes.

use async_trait::async_trait;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use tokio::sync::Mutex;
use ultracontext::{ArtifactBytes, ArtifactMeta, ErrorCode, FileWrite, UcError, UltraContext};

use super::super::mount_utils::{
    MountScope, ignored_mount_path, infer_kind, join_path, parent_path,
};
use super::super::nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_size3, specdata3,
};
use super::super::nfsserve::vfs::{
    DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities, auth_unix,
};
use super::os::{current_gid, current_uid};

const ROOT_INO: fileid3 = 1;
// Bounded conflict-retries so a concurrent writer can't make us spin on JUKEBOX (NEW#4).
const WRITE_CONFLICT_RETRIES: u32 = 5;

// Resolve `Auto` to a concrete scope via a workspace heuristic.
//
// C4: the `mount.defaultScope` config read is paired with cli-main, which converts a
// flag-less mount into its configured default before this point. A remaining `Auto`
// means there was no configured default either, so fall back to the heuristic.
pub fn resolve_mount_scope(uc: &UltraContext, scope: MountScope) -> Result<MountScope, UcError> {
    match scope {
        MountScope::Auto => {
            let workspaces = uc.list_workspaces()?;
            match workspaces.as_slice() {
                [] => {
                    let workspace = uc.ensure_default_workspace()?;
                    Ok(MountScope::Workspace(workspace.id))
                }
                [workspace] => Ok(MountScope::Workspace(workspace.id.clone())),
                _ => Ok(MountScope::Database),
            }
        }
        scope => Ok(scope),
    }
}

// The NFS server handle; all mutable engine state lives behind a single async mutex.
pub struct UcNfs {
    state: Mutex<NfsState>,
    // Stable filehandle generation so handles survive a daemon restart (G2).
    generation: u64,
}

// The mounted-tree engine state: scope, identity, the cached tree, and buffered writes.
struct NfsState {
    uc: UltraContext,
    scope: MountScope,
    uid: u32,
    gid: u32,
    tree: Tree,
    // Directories created via mkdir that have no backing artifact yet.
    virtual_dirs: BTreeSet<String>,
    // Sidecar files (e.g. .DS_Store) kept in memory only.
    virtual_files: HashMap<String, Vec<u8>>,
    // Per-path write buffers flushed as one engine version on COMMIT (D3).
    open_files: HashMap<String, OpenFile>,
}

// The cached path/inode view, rebuilt lazily and only when marked stale (D2).
struct Tree {
    paths: HashMap<String, Entry>,
    inos: HashMap<fileid3, String>,
    stale: bool,
}

// A buffered, not-yet-persisted full-file image awaiting flush on COMMIT (D3).
struct OpenFile {
    data: Vec<u8>,
}

#[derive(Debug, Clone)]
struct Entry {
    ino: fileid3,
    kind: EntryKind,
}

#[derive(Debug, Clone)]
enum EntryKind {
    Directory,
    File(ArtifactMeta),
    VirtualFile { size: u64 },
}

#[derive(Debug, Clone)]
struct ArtifactTarget {
    owner: ArtifactOwner,
    path: String,
}

#[derive(Debug, Clone)]
enum ArtifactOwner {
    Context(String),
    Workspace(String),
}

// Whether two owners refer to the same context/workspace (used to pick move vs copy).
fn same_artifact_owner(left: &ArtifactOwner, right: &ArtifactOwner) -> bool {
    match (left, right) {
        (ArtifactOwner::Context(left), ArtifactOwner::Context(right)) => left == right,
        (ArtifactOwner::Workspace(left), ArtifactOwner::Workspace(right)) => left == right,
        _ => false,
    }
}

impl UcNfs {
    pub fn new(uc: UltraContext, scope: MountScope, db_path: &str) -> Self {
        // Derive a stable generation from the database path so restarts keep filehandles valid.
        let generation = stable_generation(db_path);
        Self {
            state: Mutex::new(NfsState::new(uc, scope)),
            generation,
        }
    }
}

impl Tree {
    // A fresh tree starts with just the root and is marked stale so the first op rebuilds it.
    fn new() -> Self {
        let mut paths = HashMap::new();
        let mut inos = HashMap::new();
        paths.insert(
            String::new(),
            Entry {
                ino: ROOT_INO,
                kind: EntryKind::Directory,
            },
        );
        inos.insert(ROOT_INO, String::new());

        Self {
            paths,
            inos,
            stale: true,
        }
    }
}

impl NfsState {
    fn new(uc: UltraContext, scope: MountScope) -> Self {
        Self {
            uc,
            scope,
            uid: current_uid(),
            gid: current_gid(),
            tree: Tree::new(),
            virtual_dirs: BTreeSet::new(),
            virtual_files: HashMap::new(),
            open_files: HashMap::new(),
        }
    }

    // Mark the cached tree for rebuild on the next read-path access (D2).
    fn invalidate(&mut self) {
        self.tree.stale = true;
    }

    // Rebuild the cached tree only when stale; read-path ops reuse a clean snapshot (D2).
    fn ensure_fresh(&mut self) -> Result<(), UcError> {
        if !self.tree.stale {
            return Ok(());
        }

        let mut paths = HashMap::new();
        insert_dir_entry(&mut paths, "");

        match self.scope.clone() {
            MountScope::Context(ctx_id) => {
                for artifact in self.uc.file_list(&ctx_id, None)? {
                    insert_artifact_entry(&mut paths, artifact.path.clone(), artifact);
                }
            }
            MountScope::Workspace(workspace_id) => {
                for artifact in self.uc.file_list_workspace(&workspace_id, None)? {
                    insert_artifact_entry(&mut paths, artifact.path.clone(), artifact);
                }
            }
            MountScope::Database | MountScope::Auto => {
                insert_dir_entry(&mut paths, "workspaces");
                for workspace in self.uc.list_workspaces()? {
                    let workspace_root = join_path("workspaces", &workspace.id);
                    insert_dir_entry(&mut paths, &workspace_root);
                    for artifact in self.uc.file_list_workspace(&workspace.id, None)? {
                        let visible_path = join_path(&workspace_root, &artifact.path);
                        insert_artifact_entry(&mut paths, visible_path, artifact);
                    }
                }
            }
        }

        // Overlay virtual dirs and sidecar files that have no backing artifacts.
        for dir in self.virtual_dirs.clone() {
            insert_dir_entry(&mut paths, &dir);
        }
        for (path, data) in &self.virtual_files {
            insert_parent_dirs(&mut paths, path);
            let ino = ino_for_path(path);
            paths.insert(
                path.clone(),
                Entry {
                    ino,
                    kind: EntryKind::VirtualFile {
                        size: data.len() as u64,
                    },
                },
            );
        }

        // Reflect buffered (dirty) sizes so stat sees in-flight writes before COMMIT (D3).
        for (path, open) in &self.open_files {
            if let Some(entry) = paths.get_mut(path) {
                match &mut entry.kind {
                    EntryKind::File(meta) => meta.size = open.data.len(),
                    EntryKind::VirtualFile { size } => *size = open.data.len() as u64,
                    EntryKind::Directory => {}
                }
            }
        }

        self.tree.inos = paths
            .iter()
            .map(|(path, entry)| (entry.ino, path.clone()))
            .collect();
        self.tree.paths = paths;
        self.tree.stale = false;
        Ok(())
    }

    // Patch a single artifact entry in place after a write, avoiding a full rebuild (D2).
    fn apply_meta(&mut self, path: &str, meta: ArtifactMeta) {
        if self.tree.stale {
            return;
        }
        insert_parent_dirs(&mut self.tree.paths, path);
        let ino = ino_for_path(path);
        self.tree.inos.insert(ino, path.to_string());
        self.tree.paths.insert(
            path.to_string(),
            Entry {
                ino,
                kind: EntryKind::File(meta),
            },
        );
    }

    fn path_for_ino(&self, ino: fileid3) -> Result<String, nfsstat3> {
        self.tree
            .inos
            .get(&ino)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)
    }

    fn child_path(&self, parent: fileid3, name: &filename3) -> Result<String, nfsstat3> {
        let parent = self.path_for_ino(parent)?;
        let name = std::str::from_utf8(name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        Ok(join_path(&parent, name))
    }

    fn parent_ino(&self, path: &str) -> fileid3 {
        ino_for_path(&parent_path(path))
    }

    fn attr_for_path(&self, path: &str) -> Result<fattr3, nfsstat3> {
        let entry = self.tree.paths.get(path).ok_or(nfsstat3::NFS3ERR_NOENT)?;
        Ok(self.entry_attr(entry))
    }

    // Build fattr3, sourcing timestamps from the artifact version time, not wall clock (G2).
    fn entry_attr(&self, entry: &Entry) -> fattr3 {
        let (ftype, size, mode, nlink, time) = match &entry.kind {
            EntryKind::Directory => (ftype3::NF3DIR, 0, 0o755, 2, nfstime3::default()),
            EntryKind::File(meta) => (
                ftype3::NF3REG,
                meta.size as u64,
                0o644,
                1,
                iso_to_nfstime(&meta.created_at),
            ),
            EntryKind::VirtualFile { size } => {
                (ftype3::NF3REG, *size, 0o644, 1, nfstime3::default())
            }
        };

        fattr3 {
            ftype,
            mode,
            nlink,
            uid: self.uid,
            gid: self.gid,
            size,
            used: size,
            rdev: specdata3 {
                specdata1: 0,
                specdata2: 0,
            },
            fsid: 0,
            fileid: entry.ino,
            atime: time,
            mtime: time,
            ctime: time,
        }
    }

    // Map a visible path to the owning context/workspace + the artifact-relative path.
    fn artifact_target(&self, path: &str) -> Result<ArtifactTarget, UcError> {
        match &self.scope {
            MountScope::Context(ctx_id) => {
                if path.is_empty() {
                    Err(UcError::new(
                        ErrorCode::InvalidInput,
                        "Path is not an artifact",
                    ))
                } else {
                    Ok(ArtifactTarget {
                        owner: ArtifactOwner::Context(ctx_id.clone()),
                        path: path.to_string(),
                    })
                }
            }
            MountScope::Workspace(workspace_id) => {
                if path.is_empty() {
                    Err(UcError::new(
                        ErrorCode::InvalidInput,
                        "Path is not an artifact",
                    ))
                } else {
                    Ok(ArtifactTarget {
                        owner: ArtifactOwner::Workspace(workspace_id.clone()),
                        path: path.to_string(),
                    })
                }
            }
            MountScope::Database | MountScope::Auto => {
                let parts = path.splitn(3, '/').collect::<Vec<_>>();
                if parts.len() == 3
                    && parts[0] == "workspaces"
                    && !parts[1].is_empty()
                    && !parts[2].is_empty()
                {
                    Ok(ArtifactTarget {
                        owner: ArtifactOwner::Workspace(parts[1].to_string()),
                        path: parts[2].to_string(),
                    })
                } else {
                    Err(UcError::new(
                        ErrorCode::InvalidInput,
                        "DB-wide mount artifact paths must be under workspaces/<workspace_id>/",
                    ))
                }
            }
        }
    }

    // Directories the mount owns structurally and must not let the client mutate.
    fn is_managed_directory(&self, path: &str) -> bool {
        match &self.scope {
            MountScope::Context(_) => path.is_empty(),
            MountScope::Workspace(_) => path.is_empty(),
            MountScope::Database | MountScope::Auto => {
                path.is_empty()
                    || path == "workspaces"
                    || path
                        .strip_prefix("workspaces/")
                        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
            }
        }
    }

    // Load an artifact's bytes from the owning context/workspace.
    fn load_path(&self, path: &str) -> Result<ArtifactBytes, UcError> {
        let target = self.artifact_target(path)?;
        match target.owner {
            ArtifactOwner::Context(ctx_id) => {
                self.uc.load_artifact_bytes(&ctx_id, &target.path, None)
            }
            ArtifactOwner::Workspace(workspace_id) => {
                self.uc
                    .load_workspace_artifact_bytes(&workspace_id, &target.path, None)
            }
        }
    }

    // Current bytes for a path: buffered image if open, else virtual, else the persisted artifact.
    fn current_bytes(&self, path: &str) -> Result<Vec<u8>, UcError> {
        if let Some(open) = self.open_files.get(path) {
            Ok(open.data.clone())
        } else if let Some(data) = self.virtual_files.get(path) {
            Ok(data.clone())
        } else {
            match self.load_path(path) {
                Ok(artifact) => Ok(artifact.data),
                Err(error) if error.code == ErrorCode::NotFound => Ok(Vec::new()),
                Err(error) => Err(error),
            }
        }
    }

    // Persist a full file image now, refetching the base version and retrying on conflict (NEW#4).
    fn persist_path(&mut self, path: &str, data: Vec<u8>) -> Result<ArtifactMeta, UcError> {
        if ignored_mount_path(path) {
            // Sidecar files never hit the engine; keep them in memory.
            self.virtual_files.insert(path.to_string(), data.clone());
            self.invalidate();
            return Ok(virtual_meta(path, data.len()));
        }

        let target = self.artifact_target(path)?;
        let mut attempt = 0;
        loop {
            // Refetch the head version on every attempt so we guard against the latest, not a stale one.
            let base_version = self.load_path(path).ok().map(|artifact| artifact.version);
            let mut input = FileWrite::new(&target.path, data.clone())
                .with_kind(infer_kind(&target.path))
                .with_metadata(json!({"source": "uc-nfs"}));
            if let Some(version) = base_version {
                input = input.with_if_version(version);
            }
            let result = match &target.owner {
                ArtifactOwner::Context(ctx_id) => self.uc.file_write(ctx_id, input),
                ArtifactOwner::Workspace(workspace_id) => {
                    self.uc.file_write_workspace(workspace_id, input)
                }
            };

            match result {
                Ok(meta) => return Ok(meta),
                // Lost the race: refetch and retry instead of bubbling JUKEBOX up to the client.
                Err(error)
                    if error.code == ErrorCode::Conflict && attempt < WRITE_CONFLICT_RETRIES =>
                {
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    // Buffer bytes at an offset into the open-file image; engine write is deferred to COMMIT (D3).
    fn buffer_write(&mut self, path: &str, offset: u64, chunk: &[u8]) -> Result<(), UcError> {
        if !self.open_files.contains_key(path) {
            // First write to this path: branch the buffer off the current persisted bytes.
            let data = self.current_bytes(path)?;
            self.open_files.insert(path.to_string(), OpenFile { data });
        }

        let new_len = {
            let open = self.open_files.get_mut(path).expect("buffer just inserted");
            let offset = offset as usize;
            if open.data.len() < offset {
                open.data.resize(offset, 0);
            }
            let needed = offset + chunk.len();
            if open.data.len() < needed {
                open.data.resize(needed, 0);
            }
            open.data[offset..needed].copy_from_slice(chunk);
            open.data.len() as u64
        };

        // Reflect the new size in the cached entry without a full rebuild.
        self.patch_size(path, new_len);
        Ok(())
    }

    // Flush a single buffered file to one engine version, returning its new meta (D3).
    fn flush_path(&mut self, path: &str) -> Result<Option<ArtifactMeta>, UcError> {
        let Some(open) = self.open_files.remove(path) else {
            return Ok(None);
        };
        let meta = self.persist_path(path, open.data)?;
        self.apply_meta(path, meta.clone());
        Ok(Some(meta))
    }

    // Patch a cached entry's size in place (keeps stat cheap during buffered writes).
    fn patch_size(&mut self, path: &str, size: u64) {
        if let Some(entry) = self.tree.paths.get_mut(path) {
            match &mut entry.kind {
                EntryKind::File(meta) => meta.size = size as usize,
                EntryKind::VirtualFile { size: existing } => *existing = size,
                EntryKind::Directory => {}
            }
        }
    }

    // Remove a path: drop any buffer, then delete the virtual/sidecar or persisted artifact.
    fn remove_path(&mut self, path: &str) -> Result<(), UcError> {
        self.open_files.remove(path);
        if self.virtual_files.remove(path).is_some() {
            self.invalidate();
            return Ok(());
        }
        let target = self.artifact_target(path)?;
        let result = match target.owner {
            ArtifactOwner::Context(ctx_id) => self.uc.file_remove(&ctx_id, &target.path, None),
            ArtifactOwner::Workspace(workspace_id) => {
                self.uc
                    .file_remove_workspace(&workspace_id, &target.path, None)
            }
        };
        self.invalidate();
        result
    }

    // Truncate/extend a file to `size` and persist immediately (truncate is a sync boundary).
    fn truncate(&mut self, path: &str, size: u64) -> Result<ArtifactMeta, UcError> {
        let mut data = self.current_bytes(path)?;
        data.resize(size as usize, 0);
        self.open_files.remove(path);
        let meta = self.persist_path(path, data)?;
        self.apply_meta(path, meta.clone());
        Ok(meta)
    }

    // List the immediate children of a directory path from the cached tree.
    fn children(&self, path: &str) -> Vec<DirEntry> {
        let mut by_name = BTreeMap::new();
        for (candidate, entry) in &self.tree.paths {
            if candidate.is_empty()
                || ignored_mount_path(candidate)
                || parent_path(candidate) != path
            {
                continue;
            }
            let Some(name) = candidate.rsplit('/').next() else {
                continue;
            };
            by_name.insert(
                name.to_string(),
                DirEntry {
                    fileid: entry.ino,
                    name: name.as_bytes().into(),
                    attr: self.entry_attr(entry),
                },
            );
        }
        by_name.into_values().collect()
    }

    // Create (or truncate) a regular file in response to CREATE.
    fn create_file(&mut self, path: &str, attr: sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        if let Some(entry) = self.tree.paths.get(path) {
            if matches!(entry.kind, EntryKind::Directory) {
                return Err(nfsstat3::NFS3ERR_ISDIR);
            }
            if matches!(attr.size, set_size3::Void) {
                return Ok((entry.ino, self.entry_attr(entry)));
            }
        }

        let size = match attr.size {
            set_size3::size(size) => size,
            set_size3::Void => 0,
        };
        let saved = self.truncate(path, size).map_err(error_to_nfsstat)?;
        let ino = ino_for_path(path);
        let attr = self
            .tree
            .paths
            .get(path)
            .map(|entry| self.entry_attr(entry))
            .unwrap_or_else(|| {
                self.entry_attr(&Entry {
                    ino,
                    kind: EntryKind::File(saved),
                })
            });
        Ok((ino, attr))
    }

    // Rename a file: prefer an engine move within one owner, else copy-through + delete.
    fn rename_file(&mut self, from: &str, to: &str) -> Result<(), UcError> {
        // Flush any buffered bytes so the move/copy sees the latest content.
        self.flush_path(from)?;

        if let Some(data) = self.virtual_files.remove(from) {
            self.persist_path(to, data)?;
            self.invalidate();
            return Ok(());
        }

        let from_target = self.artifact_target(from)?;
        let source = self.load_path(from)?;
        if ignored_mount_path(to) {
            self.persist_path(to, source.data)?;
            self.remove_path(from)
        } else if let Ok(to_target) = self.artifact_target(to) {
            if same_artifact_owner(&from_target.owner, &to_target.owner)
                && self.load_path(to).is_err()
            {
                let result = match (&from_target.owner, &to_target.owner) {
                    (ArtifactOwner::Context(ctx_id), ArtifactOwner::Context(_)) => self
                        .uc
                        .file_move(ctx_id, &from_target.path, &to_target.path, None)
                        .map(|_| ()),
                    (ArtifactOwner::Workspace(workspace_id), ArtifactOwner::Workspace(_)) => self
                        .uc
                        .file_move_workspace(workspace_id, &from_target.path, &to_target.path, None)
                        .map(|_| ()),
                    _ => unreachable!(),
                };
                self.invalidate();
                result
            } else {
                self.persist_path(to, source.data)?;
                self.remove_path(from)
            }
        } else {
            Err(UcError::new(
                ErrorCode::InvalidInput,
                "Target path is not inside a mounted context",
            ))
        }
    }

    // Rename a directory by moving every child file (and virtual entry) under the new prefix.
    fn rename_directory(&mut self, from: &str, to: &str) -> Result<(), UcError> {
        if self.is_managed_directory(from) || self.is_managed_directory(to) {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Cannot rename managed mount directories",
            ));
        }

        let prefix = format!("{from}/");
        let artifact_children = self
            .tree
            .paths
            .iter()
            .filter_map(|(path, entry)| {
                matches!(entry.kind, EntryKind::File(_))
                    .then(|| {
                        path.strip_prefix(&prefix)
                            .map(|suffix| (path.clone(), suffix.to_string()))
                    })
                    .flatten()
            })
            .collect::<Vec<_>>();
        for (path, suffix) in artifact_children {
            self.rename_file(&path, &join_path(to, &suffix))?;
        }

        let virtual_children = self
            .virtual_files
            .keys()
            .filter(|path| path.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for path in virtual_children {
            let suffix = path.strip_prefix(&prefix).unwrap_or_default();
            self.rename_file(&path, &join_path(to, suffix))?;
        }

        self.virtual_dirs.remove(from);
        self.virtual_dirs.insert(to.to_string());
        self.invalidate();
        Ok(())
    }
}

// Insert a backing artifact (and its parent dirs) into a tree being built.
fn insert_artifact_entry(
    entries: &mut HashMap<String, Entry>,
    visible_path: String,
    artifact: ArtifactMeta,
) {
    if ignored_mount_path(&visible_path) {
        return;
    }
    insert_parent_dirs(entries, &visible_path);
    let ino = ino_for_path(&visible_path);
    entries.insert(
        visible_path,
        Entry {
            ino,
            kind: EntryKind::File(artifact),
        },
    );
}

// Insert a directory entry at `path`.
fn insert_dir_entry(entries: &mut HashMap<String, Entry>, path: &str) {
    let ino = ino_for_path(path);
    entries.insert(
        path.to_string(),
        Entry {
            ino,
            kind: EntryKind::Directory,
        },
    );
}

// Ensure every ancestor directory of `path` exists in the tree.
fn insert_parent_dirs(entries: &mut HashMap<String, Entry>, path: &str) {
    let mut parent = String::new();
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() < 2 {
        return;
    }
    for segment in &parts[..parts.len() - 1] {
        parent = join_path(&parent, segment);
        let ino = ino_for_path(&parent);
        entries.entry(parent.clone()).or_insert(Entry {
            ino,
            kind: EntryKind::Directory,
        });
    }
}

// Deterministic inode derived from the path so ids stay stable across rebuilds and restarts (G2).
fn ino_for_path(path: &str) -> fileid3 {
    if path.is_empty() {
        return ROOT_INO;
    }
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    // Reserve 0 (illegal) and 1 (root); fold the hash into the remaining space.
    (hasher.finish() % (u64::MAX - 1)) + 2
}

// Stable filehandle generation from the database path, replacing the startup-time default (G2).
fn stable_generation(db_path: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    db_path.hash(&mut hasher);
    hasher.finish()
}

#[async_trait]
impl NFSFileSystem for UcNfs {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadWrite
    }

    fn root_dir(&self) -> fileid3 {
        ROOT_INO
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let name = std::str::from_utf8(filename).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        if name == "." {
            return Ok(dirid);
        }

        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        if name == ".." {
            let path = state.path_for_ino(dirid)?;
            return Ok(state.parent_ino(&path));
        }

        let path = state.child_path(dirid, filename)?;
        state
            .tree
            .paths
            .get(&path)
            .map(|entry| entry.ino)
            .ok_or(nfsstat3::NFS3ERR_NOENT)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        state.attr_for_path(&path)
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        if let set_size3::size(size) = setattr.size {
            state.truncate(&path, size).map_err(error_to_nfsstat)?;
        }
        state.attr_for_path(&path)
    }

    async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        // Reads see buffered bytes first so writes are visible before COMMIT (D3).
        let data = state.current_bytes(&path).map_err(error_to_nfsstat)?;
        let start = offset as usize;
        let end = start.saturating_add(count as usize).min(data.len());
        let slice = data.get(start..end).unwrap_or_default().to_vec();
        let eof = end >= data.len();
        Ok((slice, eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        // Buffer only; the single engine version is written on COMMIT (D3).
        state
            .buffer_write(&path, offset, data)
            .map_err(error_to_nfsstat)?;
        state.attr_for_path(&path)
    }

    // Flush the buffered file for this handle into one engine version (D3 COMMIT).
    async fn commit(&self, id: fileid3, _offset: u64, _count: u32) -> Result<(), nfsstat3> {
        let mut state = self.state.lock().await;
        let path = match state.path_for_ino(id) {
            Ok(path) => path,
            // Nothing cached for this id; treat as a no-op rather than failing the COMMIT.
            Err(_) => return Ok(()),
        };
        state.flush_path(&path).map_err(error_to_nfsstat)?;
        Ok(())
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        attr: sattr3,
        _auth: &auth_unix,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, filename)?;
        state.create_file(&path, attr)
    }

    async fn create_exclusive(
        &self,
        dirid: fileid3,
        filename: &filename3,
        auth: &auth_unix,
    ) -> Result<fileid3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, filename)?;
        if state.tree.paths.contains_key(&path) {
            return Err(nfsstat3::NFS3ERR_EXIST);
        }
        let (ino, _) = state.create_file(&path, sattr3::default())?;
        let _ = auth;
        Ok(ino)
    }

    async fn mkdir(
        &self,
        dirid: fileid3,
        dirname: &filename3,
        _attr: sattr3,
        _auth: &auth_unix,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, dirname)?;
        if state.tree.paths.contains_key(&path) {
            return Err(nfsstat3::NFS3ERR_EXIST);
        }
        if state.is_managed_directory(&path) || state.artifact_target(&path).is_err() {
            return Err(nfsstat3::NFS3ERR_ACCES);
        }
        let ino = ino_for_path(&path);
        let entry = Entry {
            ino,
            kind: EntryKind::Directory,
        };
        let attr = state.entry_attr(&entry);
        state.virtual_dirs.insert(path.clone());
        state.tree.paths.insert(path.clone(), entry);
        state.tree.inos.insert(ino, path);
        Ok((ino, attr))
    }

    async fn mknod(
        &self,
        _dirid: fileid3,
        _filename: &filename3,
        _ftype: ftype3,
        _attr: sattr3,
        _rdev: specdata3,
        _auth: &auth_unix,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, filename)?;
        let entry = state
            .tree
            .paths
            .get(&path)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)?;

        match entry.kind {
            EntryKind::Directory => {
                if state.is_managed_directory(&path) {
                    return Err(nfsstat3::NFS3ERR_ACCES);
                }
                if state
                    .tree
                    .paths
                    .keys()
                    .any(|candidate| candidate != &path && parent_path(candidate) == path)
                {
                    return Err(nfsstat3::NFS3ERR_NOTEMPTY);
                }
                state.virtual_dirs.remove(&path);
                state.invalidate();
                Ok(())
            }
            EntryKind::File(_) | EntryKind::VirtualFile { .. } => {
                state.remove_path(&path).map_err(error_to_nfsstat)?;
                Ok(())
            }
        }
    }

    async fn rename(
        &self,
        from_dirid: fileid3,
        from_filename: &filename3,
        to_dirid: fileid3,
        to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let from = state.child_path(from_dirid, from_filename)?;
        let to = state.child_path(to_dirid, to_filename)?;
        let entry = state
            .tree
            .paths
            .get(&from)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)?;

        match entry.kind {
            EntryKind::Directory => state.rename_directory(&from, &to),
            EntryKind::File(_) | EntryKind::VirtualFile { .. } => state.rename_file(&from, &to),
        }
        .map_err(error_to_nfsstat)?;
        Ok(())
    }

    async fn link(
        &self,
        _id: fileid3,
        _dirid: fileid3,
        _filename: &filename3,
    ) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let mut state = self.state.lock().await;
        state.ensure_fresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(dirid)?;
        let mut entries = state.children(&path);
        entries.sort_by(|left, right| left.name.cmp(&right.name));

        let mut skip = start_after > 0;
        let mut out = Vec::new();
        let mut skipped = 0;
        for entry in entries.iter() {
            if skip {
                skipped += 1;
                if entry.fileid == start_after {
                    skip = false;
                }
                continue;
            }
            if out.len() >= max_entries {
                break;
            }
            out.push(DirEntry {
                fileid: entry.fileid,
                name: entry.name.clone(),
                attr: entry.attr,
            });
        }

        Ok(ReadDirResult {
            end: out.len() + skipped >= entries.len(),
            entries: out,
        })
    }

    async fn symlink(
        &self,
        _dirid: fileid3,
        _linkname: &filename3,
        _symlink: &nfspath3,
        _attr: &sattr3,
        _auth: &auth_unix,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_INVAL)
    }

    // Use the stable generation so filehandles stay valid across a daemon restart (G2).
    fn id_to_fh(&self, id: fileid3) -> super::super::nfsserve::nfs::nfs_fh3 {
        let mut data = Vec::new();
        data.extend_from_slice(&self.generation.to_le_bytes());
        data.extend_from_slice(&id.to_le_bytes());
        super::super::nfsserve::nfs::nfs_fh3 { data }
    }

    fn fh_to_id(&self, handle: &super::super::nfsserve::nfs::nfs_fh3) -> Result<fileid3, nfsstat3> {
        if handle.data.len() != 16 {
            return Err(nfsstat3::NFS3ERR_BADHANDLE);
        }
        let generation = u64::from_le_bytes(handle.data[0..8].try_into().unwrap());
        let id = u64::from_le_bytes(handle.data[8..16].try_into().unwrap());
        if generation != self.generation {
            return Err(nfsstat3::NFS3ERR_STALE);
        }
        Ok(id)
    }

    fn serverid(&self) -> super::super::nfsserve::nfs::cookieverf3 {
        self.generation.to_le_bytes()
    }
}

// Parse an ISO-8601 `YYYY-MM-DDThh:mm:ss(.mmm)Z` timestamp into NFS seconds/nanos (G2).
fn iso_to_nfstime(iso: &str) -> nfstime3 {
    let parsed = parse_iso(iso);
    let Some((seconds, nseconds)) = parsed else {
        return nfstime3::default();
    };
    nfstime3 {
        seconds: seconds.min(u32::MAX as u64) as u32,
        nseconds,
    }
}

// Convert an ISO timestamp to (epoch_seconds, nanos), or None when it cannot be parsed.
fn parse_iso(iso: &str) -> Option<(u64, u32)> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let minute: i64 = iso.get(14..16)?.parse().ok()?;
    let second: i64 = iso.get(17..19)?.parse().ok()?;

    // Optional fractional milliseconds after a '.'.
    let millis: u32 = iso
        .get(20..23)
        .filter(|_| bytes.get(19) == Some(&b'.'))
        .and_then(|frac| frac.parse().ok())
        .unwrap_or(0);

    let days = days_from_civil(year, month, day);
    let total = days * 86_400 + hour * 3_600 + minute * 60 + second;
    if total < 0 {
        return None;
    }
    Some((total as u64, millis * 1_000_000))
}

// Days since the Unix epoch for a civil date (inverse of the engine's civil_from_days).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// Synthesize ArtifactMeta for in-memory sidecar files.
fn virtual_meta(path: &str, size: usize) -> ArtifactMeta {
    ArtifactMeta {
        id: format!("virtual_{}", path.replace('/', "_")),
        path: path.to_string(),
        kind: infer_kind(path),
        size,
        version: 0,
        created_at: String::new(),
    }
}

// Map engine error codes onto NFS status codes.
fn error_to_nfsstat(error: UcError) -> nfsstat3 {
    match error.code {
        ErrorCode::NotFound => nfsstat3::NFS3ERR_NOENT,
        ErrorCode::Conflict | ErrorCode::Busy => nfsstat3::NFS3ERR_JUKEBOX,
        ErrorCode::InvalidInput => nfsstat3::NFS3ERR_INVAL,
        ErrorCode::IncompatibleDb | ErrorCode::Internal => nfsstat3::NFS3ERR_IO,
    }
}

// Behavioral tests that drive the NFS VFS trait over a temp engine store, no kernel mount (H3).
#[cfg(test)]
mod tests {
    use super::*;
    use ultracontext::UltraContextOptions;

    // A workspace-scoped UcNfs backed by a private in-memory engine.
    fn fixture() -> UcNfs {
        let uc = UltraContext::open_with_options(":memory:", UltraContextOptions::default())
            .expect("open in-memory engine");
        let workspace = uc.ensure_default_workspace().expect("default workspace");
        UcNfs::new(uc, MountScope::Workspace(workspace.id), ":memory:")
    }

    fn name(value: &str) -> filename3 {
        value.as_bytes().into()
    }

    // Round-trip a write through the trait and read it back.
    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let fs = fixture();
        let root = fs.root_dir();

        let (id, _) = fs
            .create(
                root,
                &name("note.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");
        fs.write(id, 0, b"hello world").await.expect("write");
        // COMMIT flushes the buffered bytes to a single engine version (D3).
        fs.commit(id, 0, 0).await.expect("commit");

        let (data, eof) = fs.read(id, 0, 1024).await.expect("read");
        assert_eq!(data, b"hello world");
        assert!(eof);
    }

    // Buffered bytes are visible to reads before COMMIT (D3).
    #[tokio::test]
    async fn buffered_write_is_visible_before_commit() {
        let fs = fixture();
        let root = fs.root_dir();
        let (id, _) = fs
            .create(
                root,
                &name("draft.txt"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");

        fs.write(id, 0, b"abc").await.expect("write");
        let (data, _) = fs.read(id, 0, 1024).await.expect("read");
        assert_eq!(data, b"abc");
    }

    // Read-modify-write: overwrite a middle range and confirm the merged result persists.
    #[tokio::test]
    async fn read_modify_write_overwrites_range() {
        let fs = fixture();
        let root = fs.root_dir();
        let (id, _) = fs
            .create(
                root,
                &name("rmw.txt"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");

        fs.write(id, 0, b"AAAAAAAA").await.expect("write base");
        fs.commit(id, 0, 0).await.expect("commit base");
        // Patch four bytes at offset 2.
        fs.write(id, 2, b"bbbb").await.expect("write patch");
        fs.commit(id, 0, 0).await.expect("commit patch");

        let (data, _) = fs.read(id, 0, 1024).await.expect("read");
        assert_eq!(data, b"AAbbbbAA");
    }

    // readdir lists created entries by name.
    #[tokio::test]
    async fn readdir_lists_children() {
        let fs = fixture();
        let root = fs.root_dir();
        for file in ["a.md", "b.md", "c.md"] {
            let (id, _) = fs
                .create(root, &name(file), sattr3::default(), &auth_unix::default())
                .await
                .expect("create");
            fs.write(id, 0, b"x").await.expect("write");
            fs.commit(id, 0, 0).await.expect("commit");
        }

        let result = fs.readdir(root, 0, 100).await.expect("readdir");
        let names: Vec<String> = result
            .entries
            .iter()
            .map(|entry| String::from_utf8_lossy(&entry.name).into_owned())
            .collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"b.md".to_string()));
        assert!(names.contains(&"c.md".to_string()));
    }

    // lookup resolves a created name to its id and getattr reports the file type.
    #[tokio::test]
    async fn lookup_and_getattr_resolve() {
        let fs = fixture();
        let root = fs.root_dir();
        let (created, _) = fs
            .create(
                root,
                &name("look.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");
        fs.write(created, 0, b"hi").await.expect("write");
        fs.commit(created, 0, 0).await.expect("commit");

        let found = fs.lookup(root, &name("look.md")).await.expect("lookup");
        assert_eq!(found, created);
        let attr = fs.getattr(found).await.expect("getattr");
        assert!(matches!(attr.ftype, ftype3::NF3REG));
        assert_eq!(attr.size, 2);
    }

    // remove deletes a file so a later lookup fails.
    #[tokio::test]
    async fn remove_deletes_file() {
        let fs = fixture();
        let root = fs.root_dir();
        let (id, _) = fs
            .create(
                root,
                &name("gone.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");
        fs.write(id, 0, b"bye").await.expect("write");
        fs.commit(id, 0, 0).await.expect("commit");

        fs.remove(root, &name("gone.md")).await.expect("remove");
        assert!(fs.lookup(root, &name("gone.md")).await.is_err());
    }

    // rename moves a file to a new name within the same scope.
    #[tokio::test]
    async fn rename_moves_file() {
        let fs = fixture();
        let root = fs.root_dir();
        let (id, _) = fs
            .create(
                root,
                &name("from.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");
        fs.write(id, 0, b"payload").await.expect("write");
        fs.commit(id, 0, 0).await.expect("commit");

        fs.rename(root, &name("from.md"), root, &name("to.md"))
            .await
            .expect("rename");
        assert!(fs.lookup(root, &name("from.md")).await.is_err());
        let moved = fs.lookup(root, &name("to.md")).await.expect("lookup moved");
        let (data, _) = fs.read(moved, 0, 1024).await.expect("read moved");
        assert_eq!(data, b"payload");
    }

    // Save-via-rename: editors write a temp file then rename it over the target.
    #[tokio::test]
    async fn save_via_rename_replaces_target() {
        let fs = fixture();
        let root = fs.root_dir();

        // Existing target file.
        let (target, _) = fs
            .create(
                root,
                &name("doc.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create target");
        fs.write(target, 0, b"old contents")
            .await
            .expect("write target");
        fs.commit(target, 0, 0).await.expect("commit target");

        // Editor writes a sibling temp file with the new contents.
        let (temp, _) = fs
            .create(
                root,
                &name("doc.md.tmp"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create temp");
        fs.write(temp, 0, b"new contents")
            .await
            .expect("write temp");
        fs.commit(temp, 0, 0).await.expect("commit temp");

        // Atomic-ish replace via rename over the existing target.
        fs.rename(root, &name("doc.md.tmp"), root, &name("doc.md"))
            .await
            .expect("rename over target");

        let doc = fs.lookup(root, &name("doc.md")).await.expect("lookup doc");
        let (data, _) = fs.read(doc, 0, 1024).await.expect("read doc");
        assert_eq!(data, b"new contents");
        assert!(fs.lookup(root, &name("doc.md.tmp")).await.is_err());
    }

    // setattr(size=0) truncates a file to empty.
    #[tokio::test]
    async fn setattr_truncates() {
        let fs = fixture();
        let root = fs.root_dir();
        let (id, _) = fs
            .create(
                root,
                &name("trunc.md"),
                sattr3::default(),
                &auth_unix::default(),
            )
            .await
            .expect("create");
        fs.write(id, 0, b"some data").await.expect("write");
        fs.commit(id, 0, 0).await.expect("commit");

        let attr = fs
            .setattr(
                id,
                sattr3 {
                    size: set_size3::size(0),
                    ..Default::default()
                },
            )
            .await
            .expect("setattr");
        assert_eq!(attr.size, 0);
        let (data, _) = fs.read(id, 0, 1024).await.expect("read");
        assert!(data.is_empty());
    }

    // Deterministic inodes: the same path always hashes to the same id (G2).
    #[test]
    fn inode_is_deterministic_for_path() {
        assert_eq!(ino_for_path("a/b/c.md"), ino_for_path("a/b/c.md"));
        assert_eq!(ino_for_path(""), ROOT_INO);
        assert_ne!(ino_for_path("a.md"), ino_for_path("b.md"));
    }

    // fattr times come from the artifact version time, not wall clock (G2).
    #[test]
    fn iso_timestamp_parses_to_epoch() {
        // 1970-01-01T00:00:01.000Z is one second after the epoch.
        let time = iso_to_nfstime("1970-01-01T00:00:01.000Z");
        assert_eq!(time.seconds, 1);
        // A known later date round-trips through the civil-date math.
        let later = iso_to_nfstime("2021-01-01T00:00:00.000Z");
        assert_eq!(later.seconds, 1_609_459_200);
    }
}
