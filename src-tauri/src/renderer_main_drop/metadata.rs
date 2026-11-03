//! Metadata only for a closed OS-event batch. No content read, canonicalization or registration.
use super::protocol::FileEntry;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
pub(super) fn validate(paths: &[PathBuf]) -> Result<Vec<String>, ()> {
    if paths.is_empty() || paths.len() > 64 {
        return Err(());
    }
    let mut total = 0usize;
    let mut seen = HashSet::new();
    let mut result = vec![];
    for path in paths {
        let text = path.to_str().ok_or(())?;
        if text.is_empty() || text.len() > 4096 || text.contains('\0') || !path.is_absolute() {
            return Err(());
        }
        total = total.checked_add(text.len()).ok_or(())?;
        if total > 64 * 1024 {
            return Err(());
        }
        if seen.insert(text.to_owned()) {
            result.push(text.to_owned())
        }
    }
    Ok(result)
}
pub(super) fn collect(paths: &[String], mut current: impl FnMut() -> bool) -> Vec<FileEntry> {
    let mut result = vec![];
    for path in paths {
        if !current() {
            break;
        }
        let p = Path::new(path);
        let Some(name) = p
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty() && n.len() <= 1024)
        else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(p) else {
            continue;
        };
        if meta.is_file() || meta.is_dir() {
            result.push(FileEntry {
                path: path.clone(),
                name: name.to_owned(),
                is_directory: meta.is_dir(),
            })
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_limits_and_first_occurrence_order_precede_metadata() {
        assert_eq!(
            validate(&["/b".into(), "/a".into(), "/b".into()]).unwrap(),
            vec!["/b", "/a"]
        );
        for paths in [
            vec![],
            vec!["relative".into()],
            vec![PathBuf::from("/a\0b")],
            vec![PathBuf::from("/".to_owned() + &"x".repeat(4096))],
            vec![PathBuf::from("/a"); 65],
        ] {
            assert!(validate(&paths).is_err())
        }
    }
    #[test]
    fn metadata_keeps_files_directories_and_does_not_open_contents() {
        let dir = std::env::temp_dir().join(format!("atools-main-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("one");
        std::fs::write(&file, b"private").unwrap();
        let paths = vec![
            file.to_str().unwrap().into(),
            dir.to_str().unwrap().into(),
            dir.join("missing").to_str().unwrap().into(),
        ];
        let entries = collect(&paths, || true);
        assert_eq!(entries.len(), 2);
        assert!(!entries[0].is_directory);
        assert!(entries[1].is_directory);
        assert!(collect(&paths, || false).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
