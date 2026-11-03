//! Strict file-path envelope validation. This inspects metadata only.
use super::registry;
use serde_json::Value;
use std::path::PathBuf;

pub(super) fn parse(value: &Value) -> Result<Vec<PathBuf>, String> {
    let object = value.as_object().ok_or("Invalid file-drag request")?;
    if object.len() != 1 || !object.contains_key("paths") {
        return Err("Invalid file-drag request".into());
    }
    let raw_paths = value["paths"].as_array().ok_or("Invalid file-drag paths")?;
    if raw_paths.is_empty() || raw_paths.len() > registry::MAX_FILES {
        return Err(format!(
            "File-drag accepts 1 to {} files",
            registry::MAX_FILES
        ));
    }

    let mut paths = Vec::with_capacity(raw_paths.len());
    let mut total_bytes = 0_usize;
    for raw_path in raw_paths {
        let raw_path = raw_path.as_str().ok_or("Invalid file-drag path")?;
        let path_bytes = raw_path.as_bytes().len();
        if raw_path.is_empty() || raw_path.contains('\0') || path_bytes > registry::MAX_PATH_BYTES {
            return Err("Invalid file-drag path length".into());
        }
        total_bytes = total_bytes
            .checked_add(path_bytes)
            .ok_or("File-drag path length overflow")?;
        if total_bytes > registry::MAX_TOTAL_PATH_BYTES {
            return Err("File-drag paths exceed the total path limit".into());
        }
        let path = PathBuf::from(raw_path);
        if !path.is_absolute() {
            return Err("File-drag paths must be absolute".into());
        }
        paths.push(path);
    }
    Ok(paths)
}

pub(super) fn canonicalize(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let mut canonical = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path
            .canonicalize()
            .map_err(|error| format!("File-drag path unavailable ({:?})", error.kind()))?;
        let metadata = path
            .metadata()
            .map_err(|error| format!("Unable to inspect file-drag path ({:?})", error.kind()))?;
        if !metadata.is_file() {
            return Err("File-drag accepts regular files only".into());
        }
        if canonical.contains(&path) {
            return Err("File-drag request contains a duplicate file".into());
        }
        canonical.push(path);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{canonicalize, parse};
    use serde_json::json;

    #[test]
    fn accepts_only_bounded_absolute_path_arrays_and_rejects_canonical_duplicates() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_string_lossy().to_string();
        assert!(parse(&json!({"paths":[path]})).is_ok());
        assert!(parse(&json!({"paths":["relative.txt"]})).is_err());
        assert!(parse(&json!({"paths":[]})).is_err());
        assert!(parse(&json!({"paths":["/tmp/a"],"extra":true})).is_err());
        assert!(
            canonicalize(vec![file.path().to_path_buf(), file.path().to_path_buf()])
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_regular_paths_without_reading_contents() {
        let directory = tempfile::tempdir().unwrap();
        assert!(canonicalize(vec![directory.path().to_path_buf()]).is_err());
    }
}
