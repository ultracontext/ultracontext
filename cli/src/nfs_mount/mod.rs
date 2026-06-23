//! NFS-backed mount of UltraContext artifacts.
//!
//! Split into three blocks: `daemon` (lifecycle + state files), `os` (per-OS shellouts
//! and probes), and `vfs` (the NFS filesystem engine bridge).

mod daemon;
mod os;
mod vfs;

pub use daemon::{MountConfig, mount, unmount};
