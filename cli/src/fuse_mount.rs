use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request, TimeOrNow,
};
use libc::{EEXIST, EIO, ENOENT, ENOTEMPTY};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use ultracontext::{
    ArtifactBytes, ArtifactMeta, ContentStore, ErrorCode, FileWrite, UcError, UltraContext,
    UltraContextOptions,
};

const ROOT_INO: u64 = 1;
const TTL: Duration = Duration::from_secs(1);

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

    let content_store = config
        .content_dir
        .as_ref()
        .map(|root| ContentStore::local_dir(root, config.inline_limit))
        .unwrap_or_else(|| ContentStore::inline_with_limit(config.inline_limit));
    let uc = UltraContext::open_with_options(&config.db, UltraContextOptions { content_store })?;
    let fs = UcFuse::new(uc, config.ctx_id);
    let options = vec![
        MountOption::FSName("ultracontext".to_string()),
        MountOption::AutoUnmount,
        MountOption::DefaultPermissions,
    ];

    fuser::mount2(fs, &config.mountpoint, &options).map_err(io_error)
}

struct UcFuse {
    uc: UltraContext,
    ctx_id: String,
    next_ino: u64,
    next_fh: u64,
    uid: u32,
    gid: u32,
    paths: HashMap<String, Entry>,
    inos: HashMap<u64, String>,
    open: HashMap<u64, OpenFile>,
    virtual_dirs: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct Entry {
    ino: u64,
    kind: EntryKind,
}

#[derive(Debug, Clone)]
enum EntryKind {
    Directory,
    File(ArtifactMeta),
    PendingFile { size: u64 },
}

#[derive(Debug, Clone)]
struct OpenFile {
    path: String,
    buffer: Vec<u8>,
    base_version: Option<usize>,
    dirty: bool,
    ignored: bool,
}

impl UcFuse {
    fn new(uc: UltraContext, ctx_id: String) -> Self {
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
            uc,
            ctx_id,
            next_ino: ROOT_INO + 1,
            next_fh: 1,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            paths,
            inos,
            open: HashMap::new(),
            virtual_dirs: BTreeSet::new(),
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

        for artifact in artifacts {
            if ignored_mount_path(&artifact.path) {
                continue;
            }

            let mut parent = String::new();
            for part in artifact
                .path
                .split('/')
                .collect::<Vec<_>>()
                .split_last()
                .into_iter()
            {
                for segment in part.1 {
                    parent = join_path(&parent, segment);
                    let ino = self.ino_for_path(&parent);
                    next.entry(parent.clone()).or_insert(Entry {
                        ino,
                        kind: EntryKind::Directory,
                    });
                }
            }

            let ino = self.ino_for_path(&artifact.path);
            next.insert(
                artifact.path.clone(),
                Entry {
                    ino,
                    kind: EntryKind::File(artifact),
                },
            );
        }

        for (path, entry) in &self.paths {
            if matches!(entry.kind, EntryKind::PendingFile { .. }) {
                next.insert(path.clone(), entry.clone());
            }
        }

        self.paths = next;
        self.inos = self
            .paths
            .iter()
            .map(|(path, entry)| (entry.ino, path.clone()))
            .collect();
        Ok(())
    }

    fn ino_for_path(&mut self, path: &str) -> u64 {
        if let Some(entry) = self.paths.get(path) {
            entry.ino
        } else {
            let ino = self.next_ino;
            self.next_ino += 1;
            ino
        }
    }

    fn path_for_ino(&self, ino: u64) -> Option<String> {
        self.inos.get(&ino).cloned()
    }

    fn child_path(&self, parent: u64, name: &OsStr) -> Result<String, i32> {
        let parent = self.path_for_ino(parent).ok_or(ENOENT)?;
        let name = name.to_str().ok_or(ENOENT)?;
        Ok(join_path(&parent, name))
    }

    fn entry_attr(&self, entry: &Entry) -> FileAttr {
        let now = SystemTime::now();
        let (kind, size, perm, nlink) = match &entry.kind {
            EntryKind::Directory => (FileType::Directory, 0, 0o755, 2),
            EntryKind::File(meta) => (FileType::RegularFile, meta.size as u64, 0o644, 1),
            EntryKind::PendingFile { size } => (FileType::RegularFile, *size, 0o644, 1),
        };
        FileAttr {
            ino: entry.ino,
            size,
            blocks: size.div_ceil(512),
            atime: now,
            mtime: now,
            ctime: now,
            crtime: now,
            kind,
            perm,
            nlink,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 512,
            flags: 0,
        }
    }

    fn load_path(&self, path: &str) -> Result<ArtifactBytes, UcError> {
        self.uc.load_artifact_bytes(&self.ctx_id, path, None)
    }

    fn open_handle(&mut self, path: String) -> Result<u64, UcError> {
        let ignored = ignored_mount_path(&path);
        let (buffer, base_version) = if ignored {
            (Vec::new(), None)
        } else {
            match self.load_path(&path) {
                Ok(artifact) => (artifact.data, Some(artifact.version)),
                Err(error) if error.code == ErrorCode::NotFound => (Vec::new(), None),
                Err(error) => return Err(error),
            }
        };
        let fh = self.next_fh;
        self.next_fh += 1;
        self.open.insert(
            fh,
            OpenFile {
                path,
                buffer,
                base_version,
                dirty: false,
                ignored,
            },
        );
        Ok(fh)
    }

    fn persist_handle(&mut self, fh: u64) -> Result<(), UcError> {
        let Some(file) = self.open.get_mut(&fh) else {
            return Ok(());
        };
        if !file.dirty {
            return Ok(());
        }

        let path = file.path.clone();
        if file.ignored {
            file.dirty = false;
            self.paths.remove(&path);
            self.inos.retain(|_, candidate| candidate != &path);
            return Ok(());
        }

        let buffer = file.buffer.clone();
        let base_version = file.base_version;

        let mut input = FileWrite::new(&path, &buffer)
            .with_kind(infer_kind(&path))
            .with_metadata(json!({"source": "uc-fuse"}));
        if let Some(version) = base_version {
            input = input.with_if_version(version);
        }
        let saved = self.uc.file_write(&self.ctx_id, input)?;

        if let Some(file) = self.open.get_mut(&fh) {
            file.base_version = Some(saved.version);
            file.dirty = false;
        }

        if let Some(entry) = self.paths.get_mut(&path) {
            entry.kind = EntryKind::File(saved);
        }
        Ok(())
    }

    fn write_path(&mut self, path: &str, data: Vec<u8>) -> Result<ArtifactMeta, UcError> {
        if ignored_mount_path(path) {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Ignored mount sidecar path",
            ));
        }
        let base_version = self.load_path(path).ok().map(|artifact| artifact.version);
        let mut input = FileWrite::new(path, data)
            .with_kind(infer_kind(path))
            .with_metadata(json!({"source": "uc-fuse-rename"}));
        if let Some(version) = base_version {
            input = input.with_if_version(version);
        }
        self.uc.file_write(&self.ctx_id, input)
    }

    fn remove_path(&mut self, path: &str) -> Result<(), UcError> {
        if self
            .paths
            .get(path)
            .is_some_and(|entry| matches!(entry.kind, EntryKind::PendingFile { .. }))
        {
            self.paths.remove(path);
            return Ok(());
        }
        self.uc.file_remove(&self.ctx_id, path, None)
    }
}

impl Filesystem for UcFuse {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        if self.refresh().is_err() {
            reply.error(EIO);
            return;
        }
        let Ok(path) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        let Some(entry) = self.paths.get(&path) else {
            reply.error(ENOENT);
            return;
        };
        reply.entry(&TTL, &self.entry_attr(entry), 0);
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        if self.refresh().is_err() {
            reply.error(EIO);
            return;
        }
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        let Some(entry) = self.paths.get(&path) else {
            reply.error(ENOENT);
            return;
        };
        reply.attr(&TTL, &self.entry_attr(entry));
    }

    fn setattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<u64>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        if let Some(size) = size
            && let Err(error) = self.truncate(ino, fh, size)
        {
            reply.error(errno(&error));
            return;
        }
        self.getattr(_req, ino, fh, reply);
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let Ok(path) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        let ino = self.ino_for_path(&path);
        let entry = Entry {
            ino,
            kind: EntryKind::Directory,
        };
        let attr = self.entry_attr(&entry);
        self.virtual_dirs.insert(path.clone());
        self.paths.insert(path.clone(), entry);
        self.inos.insert(ino, path);
        reply.entry(&TTL, &attr, 0);
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let Ok(path) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        match self.remove_path(&path) {
            Ok(()) => {
                let _ = self.refresh();
                reply.ok();
            }
            Err(error) => reply.error(errno(&error)),
        }
    }

    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let Ok(path) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        if self
            .paths
            .keys()
            .any(|candidate| candidate != &path && parent_path(candidate) == path)
        {
            reply.error(ENOTEMPTY);
            return;
        }
        self.virtual_dirs.remove(&path);
        self.paths.remove(&path);
        reply.ok();
    }

    fn rename(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        _flags: u32,
        reply: ReplyEmpty,
    ) {
        let Ok(from) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        let Ok(to) = self.child_path(newparent, newname) else {
            reply.error(ENOENT);
            return;
        };

        let result: Result<(), UcError> = if let Some(fh) = self
            .open
            .iter()
            .find_map(|(fh, file)| (file.path == from).then_some(*fh))
        {
            let data = self
                .open
                .get(&fh)
                .map(|file| file.buffer.clone())
                .unwrap_or_default();
            let target_version = self.load_path(&to).ok().map(|artifact| artifact.version);
            if let Some(file) = self.open.get_mut(&fh) {
                file.path = to.clone();
                file.base_version = target_version;
                file.dirty = true;
            }
            self.write_path(&to, data).map(|_| ())
        } else if let Ok(source) = self.load_path(&from) {
            if self.load_path(&to).is_ok() {
                match self.write_path(&to, source.data) {
                    Ok(_) => self.remove_path(&from),
                    Err(error) => Err(error),
                }
            } else {
                self.uc
                    .file_move(&self.ctx_id, &from, &to, None)
                    .map(|_| ())
            }
        } else {
            Err(UcError::new(ErrorCode::NotFound, "Artifact not found"))
        };

        match result {
            Ok(()) => {
                let _ = self.refresh();
                reply.ok();
            }
            Err(error) => reply.error(errno(&error)),
        }
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        let _writable = flags & libc::O_ACCMODE != libc::O_RDONLY;
        match self.open_handle(path) {
            Ok(fh) => reply.opened(fh, 0),
            Err(error) => reply.error(errno(&error)),
        }
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        let data = if let Some(file) = self.open.get(&fh) {
            file.buffer.clone()
        } else if let Some(path) = self.path_for_ino(ino) {
            match self.load_path(&path) {
                Ok(artifact) => artifact.data,
                Err(error) => {
                    reply.error(errno(&error));
                    return;
                }
            }
        } else {
            reply.error(ENOENT);
            return;
        };

        let start = offset.max(0) as usize;
        let end = start.saturating_add(size as usize).min(data.len());
        reply.data(data.get(start..end).unwrap_or_default());
    }

    fn write(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        if !self.open.contains_key(&fh) {
            let Some(path) = self.path_for_ino(ino) else {
                reply.error(ENOENT);
                return;
            };
            if let Err(error) = self.open_handle(path).map(|new_fh| {
                if new_fh != fh
                    && let Some(file) = self.open.remove(&new_fh)
                {
                    self.open.insert(fh, file);
                }
            }) {
                reply.error(errno(&error));
                return;
            }
        }

        let Some(file) = self.open.get_mut(&fh) else {
            reply.error(EIO);
            return;
        };
        let offset = offset.max(0) as usize;
        if file.buffer.len() < offset {
            file.buffer.resize(offset, 0);
        }
        let needed = offset + data.len();
        if file.buffer.len() < needed {
            file.buffer.resize(needed, 0);
        }
        file.buffer[offset..needed].copy_from_slice(data);
        file.dirty = true;
        if let Some(entry) = self.paths.get_mut(&file.path) {
            entry.kind = EntryKind::PendingFile {
                size: file.buffer.len() as u64,
            };
        }
        reply.written(data.len() as u32);
    }

    fn flush(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        _lock_owner: u64,
        reply: ReplyEmpty,
    ) {
        match self.persist_handle(fh) {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(errno(&error)),
        }
    }

    fn release(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        _flags: i32,
        _lock_owner: Option<u64>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let result = self.persist_handle(fh);
        self.open.remove(&fh);
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(errno(&error)),
        }
    }

    fn fsync(&mut self, _req: &Request<'_>, ino: u64, fh: u64, _datasync: bool, reply: ReplyEmpty) {
        self.flush(_req, ino, fh, 0, reply);
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        if self.refresh().is_err() {
            reply.error(EIO);
            return;
        }
        let Some(path) = self.path_for_ino(ino) else {
            reply.error(ENOENT);
            return;
        };
        let mut entries = vec![
            (ino, FileType::Directory, ".".to_string()),
            (
                self.paths
                    .get(&parent_path(&path))
                    .map(|entry| entry.ino)
                    .unwrap_or(ROOT_INO),
                FileType::Directory,
                "..".to_string(),
            ),
        ];
        entries.extend(self.children(&path));

        for (index, (child_ino, kind, name)) in
            entries.into_iter().enumerate().skip(offset as usize)
        {
            if reply.add(child_ino, (index + 1) as i64, kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn create(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let Ok(path) = self.child_path(parent, name) else {
            reply.error(ENOENT);
            return;
        };
        if self.refresh().is_ok() && self.paths.contains_key(&path) {
            reply.error(EEXIST);
            return;
        }
        let ino = self.ino_for_path(&path);
        self.paths.insert(
            path.clone(),
            Entry {
                ino,
                kind: EntryKind::PendingFile { size: 0 },
            },
        );
        self.inos.insert(ino, path.clone());
        match self.open_handle(path) {
            Ok(fh) => {
                if let Some(file) = self.open.get_mut(&fh) {
                    file.dirty = true;
                }
                let attr = self.entry_attr(self.paths.get(self.inos.get(&ino).unwrap()).unwrap());
                reply.created(&TTL, &attr, 0, fh, 0);
            }
            Err(error) => reply.error(errno(&error)),
        }
    }
}

impl UcFuse {
    fn truncate(&mut self, ino: u64, fh: Option<u64>, size: u64) -> Result<(), UcError> {
        if let Some(fh) = fh
            && let Some(file) = self.open.get_mut(&fh)
        {
            file.buffer.resize(size as usize, 0);
            file.dirty = true;
            return Ok(());
        }
        let path = self
            .path_for_ino(ino)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact not found"))?;
        let mut data = self.load_path(&path)?.data;
        data.resize(size as usize, 0);
        self.write_path(&path, data)?;
        Ok(())
    }

    fn children(&self, path: &str) -> Vec<(u64, FileType, String)> {
        let mut by_name = BTreeMap::new();
        for (candidate, entry) in &self.paths {
            if candidate.is_empty() || parent_path(candidate) != path {
                continue;
            }
            let Some(name) = candidate.rsplit('/').next() else {
                continue;
            };
            let kind = match entry.kind {
                EntryKind::Directory => FileType::Directory,
                EntryKind::File(_) | EntryKind::PendingFile { .. } => FileType::RegularFile,
            };
            by_name.insert(name.to_string(), (entry.ino, kind, name.to_string()));
        }
        by_name.into_values().collect()
    }
}

fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn ignored_mount_path(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|name| {
        name == ".DS_Store" || name.starts_with("._") || name == ".Spotlight-V100"
    })
}

fn infer_kind(path: &str) -> String {
    match Path::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("md") | Some("markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("html") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") | Some("ts") | Some("tsx") | Some("jsx") => "text/javascript",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn errno(error: &UcError) -> i32 {
    match error.code {
        ErrorCode::NotFound => ENOENT,
        ErrorCode::Conflict => libc::EAGAIN,
        ErrorCode::InvalidInput => libc::EINVAL,
        ErrorCode::Busy => libc::EBUSY,
        ErrorCode::IncompatibleDb | ErrorCode::Internal => EIO,
    }
}

fn io_error(error: std::io::Error) -> UcError {
    UcError::new(ErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_paths_match_fuse_tree_rules() {
        assert_eq!(parent_path("draft.md"), "");
        assert_eq!(parent_path("drafts/brief.md"), "drafts");
        assert_eq!(join_path("drafts", "brief.md"), "drafts/brief.md");
    }

    #[test]
    fn ignores_macos_sidecar_paths() {
        assert!(ignored_mount_path(".DS_Store"));
        assert!(ignored_mount_path("notes/._hello.md"));
        assert!(!ignored_mount_path("notes/hello.md"));
    }
}
