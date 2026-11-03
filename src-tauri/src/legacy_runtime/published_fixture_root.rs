//! Canonicalizes only the fresh fixture root created by the native smoke host.
//! This removes OS temp-directory aliases before no-follow tree verification.
use std::path::{Path, PathBuf};

#[cfg(unix)]
pub(super) fn canonicalize_created_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("PUBLISHED_FIXTURE_ROOT_INVALID".into());
    }
    let before = std::fs::symlink_metadata(path).map_err(|_| "PUBLISHED_FIXTURE_ROOT_INVALID")?;
    if before.file_type().is_symlink() || !before.file_type().is_dir() {
        return Err("PUBLISHED_FIXTURE_ROOT_INVALID".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "PUBLISHED_FIXTURE_ROOT_INVALID")?;
    let original_after =
        std::fs::symlink_metadata(path).map_err(|_| "PUBLISHED_FIXTURE_ROOT_CHANGED")?;
    let canonical_metadata =
        std::fs::symlink_metadata(&canonical).map_err(|_| "PUBLISHED_FIXTURE_ROOT_CHANGED")?;
    if original_after.file_type().is_symlink()
        || !original_after.file_type().is_dir()
        || canonical_metadata.file_type().is_symlink()
        || !canonical_metadata.file_type().is_dir()
        || !same_directory(&before, &original_after)
        || !same_directory(&before, &canonical_metadata)
    {
        return Err("PUBLISHED_FIXTURE_ROOT_CHANGED".into());
    }
    Ok(canonical)
}

#[cfg(unix)]
fn same_directory(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
pub(super) fn canonicalize_created_root(_: &Path) -> Result<PathBuf, String> {
    Err("PUBLISHED_FIXTURE_ROOT_UNSUPPORTED".into())
}

#[cfg(test)]
mod tests {
    use super::canonicalize_created_root;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn resolves_temp_parent_alias_before_nofollow_package_tree_walk() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let physical_parent = temp.path().join("physical");
        fs::create_dir(&physical_parent).unwrap();
        let alias_parent = temp.path().join("alias");
        symlink(&physical_parent, &alias_parent).unwrap();
        let requested = alias_parent.join("native-fixture");
        fs::create_dir(&requested).unwrap();

        let canonical = canonicalize_created_root(&requested).unwrap();
        assert_eq!(
            canonical,
            physical_parent
                .join("native-fixture")
                .canonicalize()
                .unwrap()
        );
        let requested_meta = fs::symlink_metadata(&requested).unwrap();
        let canonical_meta = fs::symlink_metadata(&canonical).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            (requested_meta.dev(), requested_meta.ino()),
            (canonical_meta.dev(), canonical_meta.ino())
        );
        assert!(crate::calculate_converted_package_tree(&canonical).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_at_the_fixture_root_leaf() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("fixture");
        fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(
            canonicalize_created_root(&link).unwrap_err(),
            "PUBLISHED_FIXTURE_ROOT_INVALID"
        );
        assert!(fs::symlink_metadata(&target).unwrap().is_dir());
    }
}
