//! Fixed names only, sharing the validated catalog owner.
use super::{private_owner, Profile};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
};
const ERROR: &str = "main-drop-probe-fixture-create";
fn directory_at(parent: &File, name: &[u8]) -> Result<File, &'static str> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr().cast(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(ERROR);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn same_child(root: &File, child: &File) -> bool {
    let Ok(actual) =
        directory_at(root, b"r77-main-drop\0").and_then(|f| f.metadata().map_err(|_| ERROR))
    else {
        return false;
    };
    child
        .metadata()
        .is_ok_and(|m| m.dev() == actual.dev() && m.ino() == actual.ino())
}
pub(super) fn create(profile: &Profile, seam: impl Fn(u8)) -> Result<(), &'static str> {
    if !private_owner(profile) {
        return Err("main-drop-probe-fixture-owner");
    }
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&profile.root)
        .map_err(|_| ERROR)?;
    let pinned = root.metadata().map_err(|_| ERROR)?;
    let root_current = || {
        private_owner(profile)
            && std::fs::symlink_metadata(&profile.root)
                .is_ok_and(|m| m.dev() == pinned.dev() && m.ino() == pinned.ino())
    };
    seam(0);
    if !root_current() {
        return Err(ERROR);
    }
    if unsafe { libc::mkdirat(root.as_raw_fd(), b"r77-main-drop\0".as_ptr().cast(), 0o700) } != 0 {
        return Err(ERROR);
    }
    let child = directory_at(&root, b"r77-main-drop\0")?;
    child
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|_| ERROR)?;
    seam(1);
    if !root_current() || !same_child(&root, &child) {
        return Err(ERROR);
    }
    let fd = unsafe {
        libc::openat(
            child.as_raw_fd(),
            b"file.txt\0".as_ptr().cast(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(ERROR);
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| ERROR)?;
    if !root_current() || !same_child(&root, &child) {
        return Err(ERROR);
    }
    file.write_all(b"R77 owned metadata fixture\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| ERROR)?;
    if unsafe { libc::mkdirat(child.as_raw_fd(), b"folder\0".as_ptr().cast(), 0o700) } != 0 {
        return Err(ERROR);
    }
    let folder = directory_at(&child, b"folder\0")?;
    folder
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|_| ERROR)?;
    if !root_current() || !same_child(&root, &child) {
        return Err(ERROR);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    #[test]
    fn actual_fixture_writer_rejects_root_subdir_and_file_swaps_without_touching_sentinel() {
        for attack in 0..3 {
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            let root = tempfile::Builder::new()
                .prefix("atools-drop-owned-")
                .tempdir_in(&temp)
                .unwrap();
            let outside = tempfile::Builder::new()
                .prefix("atools-drop-outside-")
                .tempdir_in(&temp)
                .unwrap();
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let profile = super::super::tests::profile_at(root.path());
            let marker = root.path().join(".atools-renderer-smoke-owner.json");
            fs::write(&marker,serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"pid":std::process::id(),"identifier":profile.identifier,"root":profile.root})).unwrap()).unwrap();
            fs::set_permissions(marker, fs::Permissions::from_mode(0o600)).unwrap();
            let sentinel = outside.path().join("sentinel");
            fs::write(&sentinel, b"unchanged").unwrap();
            let result = create(&profile, |stage| {
                let child = profile.root.join("r77-main-drop");
                if attack == 0 && stage == 0 {
                    fs::rename(&profile.root, outside.path().join("original-root")).unwrap();
                    symlink(outside.path(), &profile.root).unwrap();
                } else if attack == 1 && stage == 1 {
                    fs::rename(&child, profile.root.join("old-child")).unwrap();
                    symlink(outside.path(), child).unwrap();
                } else if attack == 2 && stage == 1 {
                    symlink(&sentinel, child.join("file.txt")).unwrap();
                }
            });
            let bytes = fs::read(&sentinel).unwrap();
            if attack == 0 {
                fs::remove_file(&profile.root).unwrap();
            }
            assert!(result.is_err(), "attack {attack} must fail");
            assert_eq!(
                bytes, b"unchanged",
                "attack {attack} changed external bytes"
            );
            assert!(!outside.path().join("r77-main-drop/file.txt").exists());
            assert!(!outside.path().join("file.txt").exists());
        }
    }
}
