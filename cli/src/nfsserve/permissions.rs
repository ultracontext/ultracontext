//! Unix permission checking for NFS operations.
//!
//! This module implements RFC 1813 compliant permission checking using
//! AUTH_UNIX credentials (uid, gid, auxiliary gids) against file mode bits.

use super::nfs::fattr3;
use super::rpc::auth_unix;

/// Permission bits for Unix file modes
pub const S_IRUSR: u32 = 0o400; // Owner read
pub const S_IWUSR: u32 = 0o200; // Owner write
pub const S_IXUSR: u32 = 0o100; // Owner execute
pub const S_IRGRP: u32 = 0o040; // Group read
pub const S_IWGRP: u32 = 0o020; // Group write
pub const S_IXGRP: u32 = 0o010; // Group execute
pub const S_IROTH: u32 = 0o004; // Other read
pub const S_IWOTH: u32 = 0o002; // Other write
pub const S_IXOTH: u32 = 0o001; // Other execute
pub const S_ISVTX: u32 = 0o1000; // Sticky bit

/// NFS ACCESS procedure permission bits (from RFC 1813)
pub const ACCESS3_READ: u32 = 0x0001;
pub const ACCESS3_LOOKUP: u32 = 0x0002;
pub const ACCESS3_MODIFY: u32 = 0x0004;
pub const ACCESS3_EXTEND: u32 = 0x0008;
pub const ACCESS3_DELETE: u32 = 0x0010;
pub const ACCESS3_EXECUTE: u32 = 0x0020;

/// Permission type for checking
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
    Execute,
}

/// Check if the given auth credentials have the specified permission on the file.
///
/// This implements standard Unix permission checking:
/// 1. Root (uid 0) always has all permissions
/// 2. If caller's uid matches file owner, check owner bits
/// 3. If caller's gid or any auxiliary gid matches file group, check group bits
/// 4. Otherwise check "other" bits
pub fn check_permission(auth: &auth_unix, attr: &fattr3, perm: Permission) -> bool {
    let mode = attr.mode;
    let file_uid = attr.uid;
    let file_gid = attr.gid;

    // Root always has access
    if auth.uid == 0 {
        return true;
    }

    // Determine which permission bits to check based on user/group/other
    let (read_bit, write_bit, exec_bit) = if auth.uid == file_uid {
        // Owner permissions
        (S_IRUSR, S_IWUSR, S_IXUSR)
    } else if is_in_group(auth, file_gid) {
        // Group permissions
        (S_IRGRP, S_IWGRP, S_IXGRP)
    } else {
        // Other permissions
        (S_IROTH, S_IWOTH, S_IXOTH)
    };

    // Check the specific permission
    match perm {
        Permission::Read => (mode & read_bit) != 0,
        Permission::Write => (mode & write_bit) != 0,
        Permission::Execute => (mode & exec_bit) != 0,
    }
}

/// Check if auth credentials are in the specified group.
/// Returns true if the primary gid matches or if gid is in auxiliary groups.
fn is_in_group(auth: &auth_unix, gid: u32) -> bool {
    if auth.gid == gid {
        return true;
    }
    auth.gids.contains(&gid)
}

/// Check if the caller can read the file.
pub fn can_read(auth: &auth_unix, attr: &fattr3) -> bool {
    check_permission(auth, attr, Permission::Read)
}

/// Check if the caller can write to the file.
pub fn can_write(auth: &auth_unix, attr: &fattr3) -> bool {
    check_permission(auth, attr, Permission::Write)
}

/// Check if the caller can execute the file or search the directory.
pub fn can_execute(auth: &auth_unix, attr: &fattr3) -> bool {
    check_permission(auth, attr, Permission::Execute)
}

/// Compute the ACCESS3 result bitmask for the given auth and file attributes.
///
/// This implements RFC 1813 ACCESS procedure semantics:
/// - ACCESS3_READ: read file data or directory contents
/// - ACCESS3_LOOKUP: search directory entries (execute permission on directories)
/// - ACCESS3_MODIFY: alter existing file/directory data
/// - ACCESS3_EXTEND: add new data or directory entries
/// - ACCESS3_DELETE: remove directory entries (checked against parent directory)
/// - ACCESS3_EXECUTE: execute files (execute permission on files)
pub fn compute_access(auth: &auth_unix, attr: &fattr3, requested: u32) -> u32 {
    let mut result = 0u32;
    let is_dir = matches!(attr.ftype, super::nfs::ftype3::NF3DIR);

    // ACCESS3_READ - read file data or directory contents
    if (requested & ACCESS3_READ) != 0 && can_read(auth, attr) {
        result |= ACCESS3_READ;
    }

    // ACCESS3_LOOKUP - search directory (execute permission on directories)
    if (requested & ACCESS3_LOOKUP) != 0 && is_dir && can_execute(auth, attr) {
        result |= ACCESS3_LOOKUP;
    }

    // ACCESS3_MODIFY - alter existing data (write permission)
    if (requested & ACCESS3_MODIFY) != 0 && can_write(auth, attr) {
        result |= ACCESS3_MODIFY;
    }

    // ACCESS3_EXTEND - add new data (write permission)
    if (requested & ACCESS3_EXTEND) != 0 && can_write(auth, attr) {
        result |= ACCESS3_EXTEND;
    }

    // ACCESS3_DELETE - for non-directory files, always 0 (per RFC 1813)
    // For directories, this would need to check parent directory permissions
    // which is handled at the operation level, not here
    if (requested & ACCESS3_DELETE) != 0 {
        // DELETE permission is checked at operation time against the parent directory
        // For the ACCESS procedure, we return 0 for files (per UNIX semantics)
        // and the directory's write permission for directories
        if is_dir && can_write(auth, attr) {
            result |= ACCESS3_DELETE;
        }
    }

    // ACCESS3_EXECUTE - execute files (not directories)
    if (requested & ACCESS3_EXECUTE) != 0 && !is_dir && can_execute(auth, attr) {
        result |= ACCESS3_EXECUTE;
    }

    result
}

/// Check if caller has permission to modify a directory (create, remove, rename entries).
/// This requires write AND execute permission on the directory.
pub fn can_modify_directory(auth: &auth_unix, dir_attr: &fattr3) -> bool {
    can_write(auth, dir_attr) && can_execute(auth, dir_attr)
}

/// Check if caller can delete/rename an entry in a directory.
/// When the directory has the sticky bit set, only root, the directory
/// owner, or the file owner can delete/rename entries.
pub fn can_delete_entry(auth: &auth_unix, dir_attr: &fattr3, entry_attr: &fattr3) -> bool {
    if !can_modify_directory(auth, dir_attr) {
        return false;
    }
    if (dir_attr.mode & S_ISVTX) == 0 {
        return true;
    }
    auth.uid == 0 || auth.uid == dir_attr.uid || auth.uid == entry_attr.uid
}

/// Check if caller is the owner of the file (or root).
/// Used for operations like chmod that require ownership.
pub fn is_owner(auth: &auth_unix, attr: &fattr3) -> bool {
    auth.uid == 0 || auth.uid == attr.uid
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nfsserve::nfs::{ftype3, nfstime3, specdata3};

    fn make_auth(uid: u32, gid: u32, gids: Vec<u32>) -> auth_unix {
        auth_unix {
            stamp: 0,
            machinename: Vec::new(),
            uid,
            gid,
            gids,
        }
    }

    fn make_attr(mode: u32, uid: u32, gid: u32, ftype: ftype3) -> fattr3 {
        fattr3 {
            ftype,
            mode,
            nlink: 1,
            uid,
            gid,
            size: 0,
            used: 0,
            rdev: specdata3::default(),
            fsid: 0,
            fileid: 1,
            atime: nfstime3::default(),
            mtime: nfstime3::default(),
            ctime: nfstime3::default(),
        }
    }

    #[test]
    fn test_root_always_allowed() {
        let auth = make_auth(0, 0, vec![]);
        let attr = make_attr(0o000, 1000, 1000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));
        assert!(can_write(&auth, &attr));
        assert!(can_execute(&auth, &attr));
    }

    #[test]
    fn test_owner_permissions() {
        let auth = make_auth(1000, 1000, vec![]);

        // Owner read only
        let attr = make_attr(0o400, 1000, 2000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));
        assert!(!can_write(&auth, &attr));
        assert!(!can_execute(&auth, &attr));

        // Owner write only
        let attr = make_attr(0o200, 1000, 2000, ftype3::NF3REG);
        assert!(!can_read(&auth, &attr));
        assert!(can_write(&auth, &attr));
        assert!(!can_execute(&auth, &attr));

        // Owner execute only
        let attr = make_attr(0o100, 1000, 2000, ftype3::NF3REG);
        assert!(!can_read(&auth, &attr));
        assert!(!can_write(&auth, &attr));
        assert!(can_execute(&auth, &attr));
    }

    #[test]
    fn test_group_permissions() {
        let auth = make_auth(1000, 2000, vec![]);

        // Group read only
        let attr = make_attr(0o040, 3000, 2000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));
        assert!(!can_write(&auth, &attr));

        // Group write only
        let attr = make_attr(0o020, 3000, 2000, ftype3::NF3REG);
        assert!(!can_read(&auth, &attr));
        assert!(can_write(&auth, &attr));
    }

    #[test]
    fn test_auxiliary_group() {
        let auth = make_auth(1000, 1000, vec![2000, 3000]);

        // User not owner, but in aux group
        let attr = make_attr(0o040, 9999, 2000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));

        let attr = make_attr(0o040, 9999, 3000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));
    }

    #[test]
    fn test_other_permissions() {
        let auth = make_auth(1000, 1000, vec![]);

        // Other read only
        let attr = make_attr(0o004, 2000, 2000, ftype3::NF3REG);
        assert!(can_read(&auth, &attr));
        assert!(!can_write(&auth, &attr));

        // Other write only
        let attr = make_attr(0o002, 2000, 2000, ftype3::NF3REG);
        assert!(!can_read(&auth, &attr));
        assert!(can_write(&auth, &attr));
    }

    #[test]
    fn test_access_computation() {
        let auth = make_auth(1000, 1000, vec![]);

        // Regular file with rwx for owner
        let attr = make_attr(0o700, 1000, 1000, ftype3::NF3REG);
        let access = compute_access(&auth, &attr, 0x3f);
        assert!((access & ACCESS3_READ) != 0);
        assert!((access & ACCESS3_MODIFY) != 0);
        assert!((access & ACCESS3_EXTEND) != 0);
        assert!((access & ACCESS3_EXECUTE) != 0);
        // LOOKUP only for directories
        assert!((access & ACCESS3_LOOKUP) == 0);

        // Directory with rwx for owner
        let attr = make_attr(0o700, 1000, 1000, ftype3::NF3DIR);
        let access = compute_access(&auth, &attr, 0x3f);
        assert!((access & ACCESS3_READ) != 0);
        assert!((access & ACCESS3_LOOKUP) != 0);
        assert!((access & ACCESS3_MODIFY) != 0);
        assert!((access & ACCESS3_EXTEND) != 0);
        assert!((access & ACCESS3_DELETE) != 0);
        // EXECUTE only for files
        assert!((access & ACCESS3_EXECUTE) == 0);
    }
}
