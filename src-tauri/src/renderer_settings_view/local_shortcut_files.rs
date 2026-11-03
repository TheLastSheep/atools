//! Bounded filesystem observations used only by the settings local-shortcut flow.
use atools_core::db::{RendererLocalShortcut, RendererLocalShortcutType};
use std::{
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_NAME_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PathFailure {
    Invalid,
    Unavailable,
}

pub(super) fn validate_absolute_path(path: &str) -> Result<(), PathFailure> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.contains('\0')
        || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
    {
        return Err(PathFailure::Invalid);
    }
    Ok(())
}

pub(super) fn build_record(path: String, id: String) -> Result<RendererLocalShortcut, PathFailure> {
    validate_absolute_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|_| PathFailure::Unavailable)?;
    let file_name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or(PathFailure::Invalid)?;
    if file_name.len() > MAX_NAME_BYTES || file_name.chars().any(char::is_control) {
        return Err(PathFailure::Invalid);
    }
    let path_ref = Path::new(&path);
    let kind = if metadata.is_file() {
        RendererLocalShortcutType::File
    } else if metadata.is_dir() && is_application_bundle(path_ref) {
        RendererLocalShortcutType::App
    } else if metadata.is_dir() {
        RendererLocalShortcutType::Folder
    } else {
        return Err(PathFailure::Invalid);
    };
    let added_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64;
    Ok(RendererLocalShortcut {
        id,
        name: file_name.to_owned(),
        path,
        kind,
        added_at,
        alias: None,
        icon: None,
        keywords: None,
        pinyin: None,
        pinyin_abbr: None,
    })
}

fn is_application_bundle(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension == "app")
        && fs::metadata(path.join("Contents/Info.plist")).is_ok_and(|metadata| metadata.is_file())
}

pub(super) fn explicitly_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

pub(super) fn missing_observation(path: &str) -> bool {
    match fs::metadata(path) {
        Ok(_) => false,
        Err(error) => explicitly_missing(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::ErrorKind};

    #[test]
    fn private_temp_file_and_directory_are_classified_without_leaking_paths() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("fixture.txt");
        File::create(&file_path).unwrap();
        let folder_path = temp.path().join("folder");
        fs::create_dir(&folder_path).unwrap();

        let file = build_record(file_path.to_str().unwrap().into(), "file-id".into()).unwrap();
        let folder =
            build_record(folder_path.to_str().unwrap().into(), "folder-id".into()).unwrap();
        assert_eq!(file.kind, RendererLocalShortcutType::File);
        assert_eq!(file.name, "fixture.txt");
        assert_eq!(folder.kind, RendererLocalShortcutType::Folder);
        assert_eq!(folder.name, "folder");
        assert_eq!(file.alias, None);
        assert_eq!(folder.path, folder_path.to_str().unwrap());
    }

    #[test]
    fn app_bundle_directory_is_typed_as_app() {
        let temp = tempfile::tempdir().unwrap();
        let app_path = temp.path().join("Fixture.app");
        fs::create_dir_all(app_path.join("Contents")).unwrap();
        File::create(app_path.join("Contents/Info.plist")).unwrap();
        let record = build_record(app_path.to_str().unwrap().into(), "app-id".into()).unwrap();
        assert_eq!(record.kind, RendererLocalShortcutType::App);
        let impostor = temp.path().join("NotAnApp.app");
        fs::create_dir(&impostor).unwrap();
        let record = build_record(impostor.to_str().unwrap().into(), "folder-id".into()).unwrap();
        assert_eq!(record.kind, RendererLocalShortcutType::Folder);
    }

    #[test]
    fn only_explicit_not_found_marks_a_shortcut_missing() {
        assert!(explicitly_missing(&io::Error::from(ErrorKind::NotFound)));
        assert!(!explicitly_missing(&io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(!explicitly_missing(&io::Error::from(ErrorKind::Other)));
    }

    #[test]
    fn path_validation_requires_absolute_utf8_bounded_non_control_input() {
        assert!(validate_absolute_path("/tmp/example").is_ok());
        assert_eq!(
            validate_absolute_path("relative"),
            Err(PathFailure::Invalid)
        );
        assert_eq!(
            validate_absolute_path("/tmp/a\0b"),
            Err(PathFailure::Invalid)
        );
        assert_eq!(
            validate_absolute_path(&"/".repeat(MAX_PATH_BYTES + 1)),
            Err(PathFailure::Invalid)
        );
    }

    #[test]
    fn missing_observation_preserves_existing_files_and_uses_not_found_only() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("present");
        File::create(&existing).unwrap();
        let missing = temp.path().join("removed");
        assert!(!missing_observation(existing.to_str().unwrap()));
        assert!(missing_observation(missing.to_str().unwrap()));
    }
}
