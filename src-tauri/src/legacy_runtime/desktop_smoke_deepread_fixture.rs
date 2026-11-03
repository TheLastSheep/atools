//! One deterministic, bounded local book created only inside the isolated fixture HOME.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const CASE_ID: &str = "converted-deepread-source";
pub(super) const BOOK_TITLE: &str = "ATools DeepRead Reader Fixture";
pub(super) const FILE_NAME: &str = "ATools-DeepRead-Reader-Fixture.txt";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum TextEncoding {
    #[default]
    Ascii,
    Utf8Bom,
}
const MAX_BYTES: usize = 16 * 1024;

fn fixture_bytes(encoding: TextEncoding) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8192);
    if encoding == TextEncoding::Utf8Bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    for index in 0..96 {
        writeln!(&mut bytes, "ATools DeepRead fixed reading line {index:03}: the original reader must retain this local passage.").unwrap();
        if index % 4 == 3 {
            bytes.push(b'\n');
        }
    }
    bytes
}

pub(super) fn prepare(downloads: &Path, encoding: TextEncoding) -> Result<PathBuf, String> {
    let path = downloads.join(FILE_NAME);
    let expected = fixture_bytes(encoding);
    if expected.len() > MAX_BYTES {
        return Err("DeepRead fixture exceeds its fixed byte budget".into());
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|_| "DeepRead fixture permissions unavailable")?;
            }
            file.write_all(&expected)
                .map_err(|_| "Unable to write fixed DeepRead fixture")?;
            file.sync_all()
                .map_err(|_| "Unable to flush fixed DeepRead fixture")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_fixed_file(&path)?;
            if existing != expected {
                return Err("Existing DeepRead fixture differs from its fixed content".into());
            }
        }
        Err(_) => return Err("Unable to create fixed DeepRead fixture".into()),
    }
    let _ = read_fixed_file(&path)?;
    Ok(path)
}

fn read_fixed_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "DeepRead fixture is unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_BYTES
    {
        return Err("DeepRead fixture must remain a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o777 != 0o600 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("DeepRead fixture ownership or private mode changed".into());
        }
    }
    let canonical = fs::canonicalize(path).map_err(|_| "DeepRead fixture path is unavailable")?;
    if canonical != path {
        return Err("DeepRead fixture path changed".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Unable to no-follow open fixed DeepRead fixture")?;
    let opened = file
        .metadata()
        .map_err(|_| "Unable to inspect fixed DeepRead fixture")?;
    if !opened.is_file()
        || opened.len() > MAX_BYTES as u64
        || opened.len() != metadata.len()
        || opened.modified().ok() != metadata.modified().ok()
    {
        return Err("DeepRead fixture changed during bounded open".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to verify fixed DeepRead fixture")?;
    if bytes.len() > MAX_BYTES || bytes.len() as u64 != opened.len() {
        return Err("DeepRead fixture exceeded its byte budget or changed while read".into());
    }
    Ok(bytes)
}

pub(super) fn evidence(
    path: &Path,
    profile: &Value,
    encoding: TextEncoding,
) -> Result<Value, String> {
    if profile["caseId"] != CASE_ID || profile["id"] != "deepread" {
        return Err("DeepRead fixture is unavailable for this published case".into());
    }
    let bytes = read_fixed_file(path)?;
    if path.file_name().and_then(|name| name.to_str()) != Some(FILE_NAME)
        || bytes != fixture_bytes(encoding)
    {
        return Err("DeepRead fixture identity differs from its fixed content".into());
    }
    let decoded = std::str::from_utf8(&bytes).map_err(|_| "DeepRead fixture text is invalid")?;
    let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(decoded);
    let normalized = decoded.trim();
    let normalized_bytes = normalized.as_bytes();
    let mut evidence = json!({"fileName":FILE_NAME,"title":BOOK_TITLE,"bytes":bytes.len(),
        "sha256":format!("{:x}", Sha256::digest(&bytes)),
        "storedContentBytes":normalized_bytes.len(),
        "storedContentSha256":format!("{:x}", Sha256::digest(normalized_bytes)),
        "readOnly":true,"content":"fixed deterministic multipage text omitted"});
    if encoding == TextEncoding::Utf8Bom {
        evidence["textEncoding"] = json!("utf8-bom");
    }
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_input_is_bounded_stable_and_never_overwrites_existing_data() {
        let root = tempfile::Builder::new()
            .prefix("atools-fixture-environment-")
            .tempdir()
            .unwrap();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let home = canonical_root.join("home");
        fs::create_dir(&home).unwrap();
        let downloads = home.join("Downloads");
        fs::create_dir(&downloads).unwrap();
        let path = prepare(&downloads, TextEncoding::Ascii).unwrap();
        let first = evidence(
            &path,
            &json!({"caseId":CASE_ID,"id":"deepread"}),
            TextEncoding::Ascii,
        )
        .unwrap();
        assert!(
            first["bytes"].as_u64().unwrap() > 4096
                && first["bytes"].as_u64().unwrap() <= MAX_BYTES as u64
        );
        assert_eq!(prepare(&downloads, TextEncoding::Ascii).unwrap(), path);
        assert_eq!(first["bytes"], 8856);
        assert_eq!(
            first["sha256"],
            "81f1d61593517a97f8f206e0df298e45bdabeaa99fc99d32009eb3b80c50ac83"
        );
        assert_eq!(first["storedContentBytes"], 8854);
        assert_eq!(
            first["storedContentSha256"],
            "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0"
        );
        assert!(
            first.get("textEncoding").is_none(),
            "default evidence keeps its prior exact shape"
        );
        assert_eq!(
            evidence(
                &path,
                &json!({"caseId":CASE_ID,"id":"deepread"}),
                TextEncoding::Ascii
            )
            .unwrap(),
            first
        );
        assert!(!first.to_string().contains(path.to_str().unwrap()));
    }

    #[test]
    fn explicit_utf8_bom_variant_is_distinct_raw_input_with_same_original_trimmed_content() {
        let root = tempfile::Builder::new()
            .prefix("atools-fixture-environment-")
            .tempdir()
            .unwrap();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let downloads = canonical_root.join("Downloads");
        fs::create_dir(&downloads).unwrap();
        let path = prepare(&downloads, TextEncoding::Utf8Bom).unwrap();
        let result = evidence(
            &path,
            &json!({"caseId":CASE_ID,"id":"deepread"}),
            TextEncoding::Utf8Bom,
        )
        .unwrap();
        assert_eq!(result["bytes"], 8859);
        assert_eq!(
            result["sha256"],
            "238396bdcc00c617be26664adeca4c60d72bfa9f2ef9ef074632c73a4cc76052"
        );
        assert_eq!(result["textEncoding"], "utf8-bom");
        assert_eq!(result["storedContentBytes"], 8854);
        assert_eq!(
            result["storedContentSha256"],
            "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0"
        );
        assert_eq!(prepare(&downloads, TextEncoding::Utf8Bom).unwrap(), path);
        assert!(
            prepare(&downloads, TextEncoding::Ascii).is_err(),
            "existing input is never overwritten across variants"
        );
    }

    #[test]
    fn fixture_rejects_symlink_and_wrong_case_without_reading_arbitrary_paths() {
        let root = tempfile::Builder::new()
            .prefix("atools-fixture-environment-")
            .tempdir()
            .unwrap();
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let downloads = canonical_root.join("Downloads");
        fs::create_dir(&downloads).unwrap();
        let outside = canonical_root.join("outside.txt");
        fs::write(&outside, fixture_bytes(TextEncoding::Ascii)).unwrap();
        let path = downloads.join(FILE_NAME);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        #[cfg(unix)]
        assert!(prepare(&downloads, TextEncoding::Ascii).is_err());
        assert!(evidence(
            &outside,
            &json!({"caseId":"other","id":"deepread"}),
            TextEncoding::Ascii
        )
        .is_err());
    }
}
