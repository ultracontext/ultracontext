use std::path::Path;
use ultracontext::{ErrorCode, UcError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountScope {
    Auto,
    Database,
    Workspace(String),
    Context(String),
}

pub fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

pub fn parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

pub fn ignored_mount_path(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|name| {
        name == ".DS_Store" || name.starts_with("._") || name == ".Spotlight-V100"
    })
}

pub fn infer_kind(path: &str) -> String {
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
        _ => "text/plain",
    }
    .to_string()
}

pub fn io_error(error: std::io::Error) -> UcError {
    UcError::new(ErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_paths_match_mount_tree_rules() {
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
