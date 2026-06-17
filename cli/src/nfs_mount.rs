use async_trait::async_trait;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use ultracontext::{
    ArtifactBytes, ArtifactMeta, ContentStore, ErrorCode, FileWrite, UcError, UltraContext,
    UltraContextOptions,
};

use crate::mount_utils::{ignored_mount_path, infer_kind, io_error, join_path, parent_path};
use crate::nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_size3, specdata3,
};
use crate::nfsserve::tcp::{NFSTcp, NFSTcpListener};
use crate::nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities, auth_unix};

const ROOT_INO: fileid3 = 1;
const DEFAULT_NFS_PORT: u16 = 11111;

pub struct MountConfig {
    pub db: String,
    pub content_dir: Option<PathBuf>,
    pub inline_limit: usize,
    pub ctx_id: String,
    pub mountpoint: PathBuf,
    pub foreground: bool,
}

pub fn mount(config: MountConfig) -> Result<(), UcError> {
    if !config.foreground {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "background mount is not supported yet; run `uc mount` in the foreground",
        ));
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(io_error)?;
    runtime.block_on(mount_async(config))
}

async fn mount_async(config: MountConfig) -> Result<(), UcError> {
    let content_store = config
        .content_dir
        .as_ref()
        .map(|root| ContentStore::local_dir(root, config.inline_limit))
        .unwrap_or_else(|| ContentStore::inline_with_limit(config.inline_limit));
    let uc = UltraContext::open_with_options(&config.db, UltraContextOptions { content_store })?;
    let fs = UcNfs::new(uc, config.ctx_id);
    let port = find_available_port(DEFAULT_NFS_PORT)?;
    let bind_addr = format!("127.0.0.1:{port}");
    let listener = NFSTcpListener::bind(&bind_addr, fs)
        .await
        .map_err(io_error)?;

    let server = tokio::spawn(async move {
        let _ = listener.handle_forever().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    mount_nfs(port, &config.mountpoint)?;

    wait_for_shutdown().await;
    let _ = unmount_nfs(&config.mountpoint);
    server.abort();
    Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(not(unix))]
async fn wait_for_shutdown() {
    std::future::pending::<()>().await;
}

fn find_available_port(start: u16) -> Result<u16, UcError> {
    for port in start..start.saturating_add(100) {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(UcError::new(
        ErrorCode::Busy,
        format!("No available NFS port in range {start}-{}", start + 99),
    ))
}

#[cfg(target_os = "macos")]
fn mount_nfs(port: u16, mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("/sbin/mount_nfs")
        .args([
            "-o",
            &format!("locallocks,vers=3,tcp,port={port},mountport={port},soft,timeo=10,retrans=2"),
            "127.0.0.1:/",
            &mountpoint.to_string_lossy(),
        ])
        .output()
        .map_err(io_error)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::InvalidInput,
            format!(
                "Failed to mount NFS: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

#[cfg(target_os = "linux")]
fn mount_nfs(port: u16, mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("mount")
        .args([
            "-t",
            "nfs",
            "-o",
            &format!("vers=3,tcp,port={port},mountport={port},nolock,soft,timeo=10,retrans=2"),
            "127.0.0.1:/",
            &mountpoint.to_string_lossy(),
        ])
        .output()
        .map_err(io_error)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::InvalidInput,
            format!(
                "Failed to mount NFS: {}. Make sure NFS client tools are installed.",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn mount_nfs(_port: u16, _mountpoint: &Path) -> Result<(), UcError> {
    Err(UcError::new(
        ErrorCode::InvalidInput,
        "NFS mount is currently implemented for macOS and Linux",
    ))
}

#[cfg(target_os = "macos")]
fn unmount_nfs(mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("/sbin/umount")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if output.status.success() {
        return Ok(());
    }

    let forced = Command::new("/sbin/umount")
        .arg("-f")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if forced.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::Internal,
            format!(
                "Failed to unmount NFS: {}",
                String::from_utf8_lossy(&forced.stderr).trim()
            ),
        ))
    }
}

#[cfg(target_os = "linux")]
fn unmount_nfs(mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("umount")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if output.status.success() {
        return Ok(());
    }

    let lazy = Command::new("umount")
        .arg("-l")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if lazy.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::Internal,
            format!(
                "Failed to unmount NFS: {}",
                String::from_utf8_lossy(&lazy.stderr).trim()
            ),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn unmount_nfs(_mountpoint: &Path) -> Result<(), UcError> {
    Ok(())
}

struct UcNfs {
    state: Mutex<NfsState>,
}

struct NfsState {
    uc: UltraContext,
    ctx_id: String,
    next_ino: fileid3,
    uid: u32,
    gid: u32,
    paths: HashMap<String, Entry>,
    inos: HashMap<fileid3, String>,
    path_inos: HashMap<String, fileid3>,
    virtual_dirs: BTreeSet<String>,
    virtual_files: HashMap<String, Vec<u8>>,
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

impl UcNfs {
    fn new(uc: UltraContext, ctx_id: String) -> Self {
        Self {
            state: Mutex::new(NfsState::new(uc, ctx_id)),
        }
    }
}

impl NfsState {
    fn new(uc: UltraContext, ctx_id: String) -> Self {
        let mut paths = HashMap::new();
        let mut inos = HashMap::new();
        let mut path_inos = HashMap::new();
        paths.insert(
            String::new(),
            Entry {
                ino: ROOT_INO,
                kind: EntryKind::Directory,
            },
        );
        inos.insert(ROOT_INO, String::new());
        path_inos.insert(String::new(), ROOT_INO);

        Self {
            uc,
            ctx_id,
            next_ino: ROOT_INO + 1,
            uid: current_uid(),
            gid: current_gid(),
            paths,
            inos,
            path_inos,
            virtual_dirs: BTreeSet::new(),
            virtual_files: HashMap::new(),
        }
    }

    fn refresh(&mut self) -> Result<(), UcError> {
        let artifacts = self.uc.file_list(&self.ctx_id, None)?;
        let mut next = HashMap::new();
        next.insert(
            String::new(),
            Entry {
                ino: ROOT_INO,
                kind: EntryKind::Directory,
            },
        );

        for dir in self.virtual_dirs.clone() {
            let ino = self.ino_for_path(&dir);
            next.insert(
                dir,
                Entry {
                    ino,
                    kind: EntryKind::Directory,
                },
            );
        }

        for (path, data) in self.virtual_files.clone() {
            self.insert_parent_dirs(&mut next, &path);
            let ino = self.ino_for_path(&path);
            next.insert(
                path,
                Entry {
                    ino,
                    kind: EntryKind::VirtualFile {
                        size: data.len() as u64,
                    },
                },
            );
        }

        for artifact in artifacts {
            if ignored_mount_path(&artifact.path) {
                continue;
            }
            self.insert_parent_dirs(&mut next, &artifact.path);
            let ino = self.ino_for_path(&artifact.path);
            next.insert(
                artifact.path.clone(),
                Entry {
                    ino,
                    kind: EntryKind::File(artifact),
                },
            );
        }

        self.paths = next;
        self.inos = self
            .paths
            .iter()
            .map(|(path, entry)| (entry.ino, path.clone()))
            .collect();
        Ok(())
    }

    fn insert_parent_dirs(&mut self, entries: &mut HashMap<String, Entry>, path: &str) {
        let mut parent = String::new();
        let parts = path.split('/').collect::<Vec<_>>();
        if parts.len() < 2 {
            return;
        }
        for segment in &parts[..parts.len() - 1] {
            parent = join_path(&parent, segment);
            let ino = self.ino_for_path(&parent);
            entries.entry(parent.clone()).or_insert(Entry {
                ino,
                kind: EntryKind::Directory,
            });
        }
    }

    fn ino_for_path(&mut self, path: &str) -> fileid3 {
        if let Some(ino) = self.path_inos.get(path) {
            *ino
        } else {
            let ino = self.next_ino;
            self.next_ino += 1;
            self.path_inos.insert(path.to_string(), ino);
            ino
        }
    }

    fn path_for_ino(&self, ino: fileid3) -> Result<String, nfsstat3> {
        self.inos.get(&ino).cloned().ok_or(nfsstat3::NFS3ERR_NOENT)
    }

    fn child_path(&self, parent: fileid3, name: &filename3) -> Result<String, nfsstat3> {
        let parent = self.path_for_ino(parent)?;
        let name = std::str::from_utf8(name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        Ok(join_path(&parent, name))
    }

    fn parent_ino(&mut self, path: &str) -> fileid3 {
        let parent = parent_path(path);
        self.ino_for_path(&parent)
    }

    fn attr_for_path(&self, path: &str) -> Result<fattr3, nfsstat3> {
        let entry = self.paths.get(path).ok_or(nfsstat3::NFS3ERR_NOENT)?;
        Ok(self.entry_attr(entry))
    }

    fn entry_attr(&self, entry: &Entry) -> fattr3 {
        let now = nfs_now();
        let (ftype, size, mode, nlink) = match &entry.kind {
            EntryKind::Directory => (ftype3::NF3DIR, 0, 0o755, 2),
            EntryKind::File(meta) => (ftype3::NF3REG, meta.size as u64, 0o644, 1),
            EntryKind::VirtualFile { size } => (ftype3::NF3REG, *size, 0o644, 1),
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
            atime: now,
            mtime: now,
            ctime: now,
        }
    }

    fn load_path(&self, path: &str) -> Result<ArtifactBytes, UcError> {
        self.uc.load_artifact_bytes(&self.ctx_id, path, None)
    }

    fn write_path(&mut self, path: &str, data: Vec<u8>) -> Result<ArtifactMeta, UcError> {
        if ignored_mount_path(path) {
            self.virtual_files.insert(path.to_string(), data.clone());
            let ino = self.ino_for_path(path);
            self.paths.insert(
                path.to_string(),
                Entry {
                    ino,
                    kind: EntryKind::VirtualFile {
                        size: data.len() as u64,
                    },
                },
            );
            self.inos.insert(ino, path.to_string());
            return Ok(virtual_meta(path, data.len()));
        }

        let base_version = self.load_path(path).ok().map(|artifact| artifact.version);
        let mut input = FileWrite::new(path, data)
            .with_kind(infer_kind(path))
            .with_metadata(json!({"source": "uc-nfs"}));
        if let Some(version) = base_version {
            input = input.with_if_version(version);
        }
        self.uc.file_write(&self.ctx_id, input)
    }

    fn remove_path(&mut self, path: &str) -> Result<(), UcError> {
        if self.virtual_files.remove(path).is_some() {
            self.paths.remove(path);
            self.inos.retain(|_, candidate| candidate != path);
            return Ok(());
        }
        self.uc.file_remove(&self.ctx_id, path, None)
    }

    fn truncate(&mut self, path: &str, size: u64) -> Result<ArtifactMeta, UcError> {
        let mut data = if let Some(data) = self.virtual_files.get(path) {
            data.clone()
        } else {
            match self.load_path(path) {
                Ok(artifact) => artifact.data,
                Err(error) if error.code == ErrorCode::NotFound => Vec::new(),
                Err(error) => return Err(error),
            }
        };
        data.resize(size as usize, 0);
        self.write_path(path, data)
    }

    fn write_at(&mut self, path: &str, offset: u64, chunk: &[u8]) -> Result<ArtifactMeta, UcError> {
        let mut data = if let Some(data) = self.virtual_files.get(path) {
            data.clone()
        } else {
            match self.load_path(path) {
                Ok(artifact) => artifact.data,
                Err(error) if error.code == ErrorCode::NotFound => Vec::new(),
                Err(error) => return Err(error),
            }
        };
        let offset = offset as usize;
        if data.len() < offset {
            data.resize(offset, 0);
        }
        let needed = offset + chunk.len();
        if data.len() < needed {
            data.resize(needed, 0);
        }
        data[offset..needed].copy_from_slice(chunk);
        self.write_path(path, data)
    }

    fn children(&self, path: &str) -> Vec<DirEntry> {
        let mut by_name = BTreeMap::new();
        for (candidate, entry) in &self.paths {
            if candidate.is_empty() || parent_path(candidate) != path {
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

    fn create_file(&mut self, path: &str, attr: sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        if let Some(entry) = self.paths.get(path)
            && matches!(attr.size, set_size3::Void)
        {
            return Ok((entry.ino, self.entry_attr(entry)));
        }

        let size = match attr.size {
            set_size3::size(size) => size,
            set_size3::Void => 0,
        };
        let saved = self.truncate(path, size).map_err(error_to_nfsstat)?;
        self.refresh().map_err(error_to_nfsstat)?;
        let ino = self.ino_for_path(path);
        let attr = self
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

    fn rename_file(&mut self, from: &str, to: &str) -> Result<(), UcError> {
        if let Some(data) = self.virtual_files.remove(from) {
            self.write_path(to, data)?;
            self.paths.remove(from);
            self.inos.retain(|_, candidate| candidate != from);
            return Ok(());
        }

        let source = self.load_path(from)?;
        if self.load_path(to).is_ok() || ignored_mount_path(to) {
            self.write_path(to, source.data)?;
            self.remove_path(from)
        } else {
            self.uc.file_move(&self.ctx_id, from, to, None).map(|_| ())
        }
    }

    fn rename_directory(&mut self, from: &str, to: &str) -> Result<(), UcError> {
        let prefix = format!("{from}/");
        let artifacts = self.uc.file_list(&self.ctx_id, Some(&prefix))?;
        for artifact in artifacts {
            let suffix = artifact
                .path
                .strip_prefix(&prefix)
                .ok_or_else(|| UcError::new(ErrorCode::Internal, "Invalid directory rename"))?;
            self.rename_file(&artifact.path, &join_path(to, suffix))?;
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
        Ok(())
    }
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
        state.refresh().map_err(error_to_nfsstat)?;
        if name == ".." {
            let path = state.path_for_ino(dirid)?;
            return Ok(state.parent_ino(&path));
        }

        let path = state.child_path(dirid, filename)?;
        state
            .paths
            .get(&path)
            .map(|entry| entry.ino)
            .ok_or(nfsstat3::NFS3ERR_NOENT)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        state.attr_for_path(&path)
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        if let set_size3::size(size) = setattr.size {
            state.truncate(&path, size).map_err(error_to_nfsstat)?;
            state.refresh().map_err(error_to_nfsstat)?;
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
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        let data = if let Some(data) = state.virtual_files.get(&path) {
            data.clone()
        } else {
            state.load_path(&path).map_err(error_to_nfsstat)?.data
        };
        let start = offset as usize;
        let end = start.saturating_add(count as usize).min(data.len());
        let slice = data.get(start..end).unwrap_or_default().to_vec();
        let eof = end >= data.len();
        Ok((slice, eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let mut state = self.state.lock().await;
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.path_for_ino(id)?;
        state
            .write_at(&path, offset, data)
            .map_err(error_to_nfsstat)?;
        state.refresh().map_err(error_to_nfsstat)?;
        state.attr_for_path(&path)
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        attr: sattr3,
        _auth: &auth_unix,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let mut state = self.state.lock().await;
        state.refresh().map_err(error_to_nfsstat)?;
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
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, filename)?;
        if state.paths.contains_key(&path) {
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
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, dirname)?;
        if state.paths.contains_key(&path) {
            return Err(nfsstat3::NFS3ERR_EXIST);
        }
        let ino = state.ino_for_path(&path);
        let entry = Entry {
            ino,
            kind: EntryKind::Directory,
        };
        let attr = state.entry_attr(&entry);
        state.virtual_dirs.insert(path.clone());
        state.paths.insert(path.clone(), entry);
        state.inos.insert(ino, path);
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
        state.refresh().map_err(error_to_nfsstat)?;
        let path = state.child_path(dirid, filename)?;
        let entry = state
            .paths
            .get(&path)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)?;

        match entry.kind {
            EntryKind::Directory => {
                if state
                    .paths
                    .keys()
                    .any(|candidate| candidate != &path && parent_path(candidate) == path)
                {
                    return Err(nfsstat3::NFS3ERR_NOTEMPTY);
                }
                state.virtual_dirs.remove(&path);
                state.paths.remove(&path);
                state.inos.retain(|_, candidate| candidate != &path);
                Ok(())
            }
            EntryKind::File(_) | EntryKind::VirtualFile { .. } => {
                state.remove_path(&path).map_err(error_to_nfsstat)?;
                state.refresh().map_err(error_to_nfsstat)?;
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
        state.refresh().map_err(error_to_nfsstat)?;
        let from = state.child_path(from_dirid, from_filename)?;
        let to = state.child_path(to_dirid, to_filename)?;
        let entry = state
            .paths
            .get(&from)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)?;

        match entry.kind {
            EntryKind::Directory => state.rename_directory(&from, &to),
            EntryKind::File(_) | EntryKind::VirtualFile { .. } => state.rename_file(&from, &to),
        }
        .map_err(error_to_nfsstat)?;
        state.refresh().map_err(error_to_nfsstat)?;
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
        state.refresh().map_err(error_to_nfsstat)?;
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
}

fn current_uid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn current_gid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getgid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn nfs_now() -> nfstime3 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    nfstime3 {
        seconds: duration.as_secs().min(u32::MAX as u64) as u32,
        nseconds: duration.subsec_nanos(),
    }
}

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

fn error_to_nfsstat(error: UcError) -> nfsstat3 {
    match error.code {
        ErrorCode::NotFound => nfsstat3::NFS3ERR_NOENT,
        ErrorCode::Conflict | ErrorCode::Busy => nfsstat3::NFS3ERR_JUKEBOX,
        ErrorCode::InvalidInput => nfsstat3::NFS3ERR_INVAL,
        ErrorCode::IncompatibleDb | ErrorCode::Internal => nfsstat3::NFS3ERR_IO,
    }
}
