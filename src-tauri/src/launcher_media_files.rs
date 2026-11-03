//! Host-derived file metadata. Names and kind flags supplied by a frontend are never trusted.
use atools_core::matcher::{
    MediaFile, MAX_MEDIA_FILES, MAX_MEDIA_PATH_BYTES, MAX_MEDIA_PATH_TOTAL_BYTES,
};
use std::path::Path;

pub(crate) fn validate_paths(paths: &[String]) -> Result<Vec<MediaFile>, String> {
    if paths.is_empty() {
        return Err("FILE_INPUT_EMPTY: select at least one file or directory".into());
    }
    if paths.len() > MAX_MEDIA_FILES {
        return Err("FILE_INPUT_BUDGET: at most 1000 selected entries are supported".into());
    }
    let mut total = 0usize;
    // Validate the entire shape before any filesystem access; never truncate.
    for (index, value) in paths.iter().enumerate() {
        total = total
            .checked_add(value.len())
            .ok_or("FILE_INPUT_BUDGET: path bytes overflow")?;
        if value.len() > MAX_MEDIA_PATH_BYTES || total > MAX_MEDIA_PATH_TOTAL_BYTES {
            return Err("FILE_INPUT_BUDGET: paths exceed 8192 bytes each or 256 KiB total".into());
        }
        if !Path::new(value).is_absolute() || value.contains('\0') {
            return Err(format!(
                "FILE_INPUT_INVALID: selected entry {index} needs an absolute local path"
            ));
        }
    }
    paths.iter().enumerate().map(|(index,value)| {
        let path=Path::new(value);
        // Follow a symlink for type validation, while preserving its absolute selected path.
        let metadata=path.metadata().map_err(|_|format!("FILE_INPUT_UNAVAILABLE: selected entry {index} cannot be read; select again"))?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(format!("FILE_INPUT_UNSUPPORTED: selected entry {index} is not a regular file or directory"));
        }
        let name=path.file_name().unwrap_or(path.as_os_str()).to_str()
            .ok_or_else(||format!("FILE_INPUT_INVALID: selected entry {index} has a non-UTF8 name"))?;
        if name.is_empty() {return Err(format!("FILE_INPUT_INVALID: selected entry {index} has no name"));}
        Ok(MediaFile{path:value.clone(),name:name.into(),is_file:metadata.is_file(),is_directory:metadata.is_dir()})
    }).collect()
}
