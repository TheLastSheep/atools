//! Positive original-preload evidence, confined to the actual fixture HOME before GUI startup.
use atools_core::{task_run::TaskRunStatus, Database};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const CONTENT: &[u8] = b"ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n";

fn validate_downloads(home: &Path, downloads: &Path) -> Result<(), String> {
    let parent = home.parent().ok_or("Missing private fixture home")?;
    if home.file_name().and_then(|s| s.to_str()) != Some("home")
        || !parent
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("atools-fixture-environment-"))
        || std::fs::canonicalize(home).map_err(|_| "Private fixture home unavailable")? != home
        || downloads != home.join("Downloads")
    {
        return Err(
            "Refusing filesystem verification outside the actual private fixture HOME".into(),
        );
    }
    for path in [parent, home] {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Private fixture directory unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Invalid private fixture directory".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o777 != 0o700 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err("Private fixture directory ownership/mode changed".into());
            }
        }
    }
    if let Ok(metadata) = std::fs::symlink_metadata(downloads) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Fixture Downloads must be a real directory".into());
        }
    }
    Ok(())
}

fn prepare_deepread_fixture(
    profile: &Value,
    home: &Path,
    downloads: &Path,
    encoding: super::deepread_fixture::TextEncoding,
) -> Result<Option<PathBuf>, String> {
    if profile["caseId"] != super::deepread_fixture::CASE_ID {
        return Ok(None);
    }
    if profile["pathAccess"] != "none" {
        return Err("DeepRead fixture requires the reviewed no-path-permission profile".into());
    }
    validate_downloads(home, downloads)?;
    std::fs::create_dir(downloads).map_err(|_| "Unable to create private fixture Downloads")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(downloads, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Unable to secure private fixture Downloads")?;
    }
    validate_downloads(home, downloads)?;
    let _ = super::deepread_fixture::prepare(downloads, encoding)?;
    Ok(Some(downloads.to_path_buf()))
}

fn prepare_image_stitch_fixture(
    profile: &Value,
    home: &Path,
    downloads: &Path,
) -> Result<Option<PathBuf>, String> {
    if profile["caseId"] != super::image_stitch_fixture::CASE_ID {
        return Ok(None);
    }
    if !super::image_stitch_fixture::profile_matches(profile) {
        return Err("Image Stitch fixture requires its exact reviewed no-path profile".into());
    }
    validate_downloads(home, downloads)?;
    std::fs::create_dir(downloads).map_err(|_| "Unable to create private fixture Downloads")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(downloads, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Unable to secure private fixture Downloads")?;
    }
    validate_downloads(home, downloads)?;
    super::image_stitch_fixture::prepare(profile, downloads)?;
    Ok(Some(downloads.to_path_buf()))
}

pub(super) fn prepare(
    profile: &Value,
    encoding: super::deepread_fixture::TextEncoding,
) -> Result<Option<PathBuf>, String> {
    if profile["caseId"] == super::deepread_fixture::CASE_ID {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("Missing private fixture HOME")?;
        let downloads = dirs::download_dir().ok_or("Native Downloads resolver unavailable")?;
        return prepare_deepread_fixture(profile, &home, &downloads, encoding);
    }
    if profile["caseId"] == super::image_stitch_fixture::CASE_ID {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("Missing private fixture HOME")?;
        let downloads = dirs::download_dir().ok_or("Native Downloads resolver unavailable")?;
        return prepare_image_stitch_fixture(profile, &home, &downloads);
    }
    if profile["caseId"] != "regex-editor" || profile["pathAccess"] != "standard" {
        return Ok(None);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Missing private fixture HOME")?;
    let downloads = dirs::download_dir().ok_or("Native Downloads resolver unavailable")?;
    validate_downloads(&home, &downloads)?;
    std::fs::create_dir(&downloads).map_err(|_| "Unable to create private fixture Downloads")?;
    Ok(Some(downloads))
}

pub(super) fn image_stitch_fixture(
    profile: &Value,
    downloads: Option<&Path>,
    run_id: &str,
) -> Result<Value, String> {
    if !super::image_stitch_fixture::profile_matches(profile) {
        return Err("Image Stitch fixture is unavailable for this reviewed package".into());
    }
    let downloads = downloads.ok_or("Private Image Stitch Downloads were not prepared")?;
    let home = downloads.parent().ok_or("Invalid private Downloads")?;
    validate_downloads(home, downloads)?;
    super::image_stitch_fixture::evidence(profile, downloads, run_id)
}

pub(super) fn evidence(
    db: &Database,
    profile: &Value,
    downloads: Option<&Path>,
) -> Result<Value, String> {
    if profile["caseId"] != "regex-editor" || profile["pathAccess"] != "standard" {
        return Err("No reviewed path write for this case".into());
    }
    let downloads = downloads.ok_or("Private Downloads was not checked before startup")?;
    let home = downloads.parent().ok_or("Invalid private Downloads")?;
    validate_downloads(home, downloads)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(downloads).map_err(|_| "Private Downloads unavailable")? {
        if files.len() >= 4 {
            return Err("Unexpected private Downloads entry count".into());
        }
        let entry = entry.map_err(|_| "Unable to inspect private Downloads")?;
        let metadata =
            std::fs::symlink_metadata(entry.path()).map_err(|_| "Fixture output unavailable")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid fixture filename")?;
        let stem = name.strip_suffix(".txt").unwrap_or("");
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 256
            || stem.is_empty()
            || !stem.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("Unexpected original preload output".into());
        }
        files.push(std::fs::read(entry.path()).map_err(|_| "Unable to read fixture output")?);
    }
    let runs = db
        .list_task_runs(1000)
        .map_err(|_| "Unable to inspect path history")?;
    let name = crate::plugin_system_paths::registry::tool_name(
        "regex-editor",
        crate::plugin_system_paths::registry::Access::Standard,
    );
    let selected = runs
        .iter()
        .filter(|run| run.capability_id == name)
        .collect::<Vec<_>>();
    let private_home = home.to_string_lossy();
    let history_private = runs.iter().all(|run| {
        serde_json::to_string(run).is_ok_and(|text| {
            !text.contains("ATOOLS_PATH_SNAPSHOT_SYNTHETIC")
                && !text.contains(private_home.as_ref())
        })
    });
    Ok(
        json!({"confinedToPrivateHome":true,"fileCount":files.len(),"contentMatches":files.len()==1 && files[0]==CONTENT,
        "actualBytes":files.iter().map(Vec::len).sum::<usize>(),"standardPathTaskRunCount":selected.len(),
        "standardPathRunsSucceeded":selected.iter().all(|run|run.status==TaskRunStatus::Succeeded),
        "privateMarkersAbsent":history_private,"readOnlyEvidence":true,
        "source":"actual private native Downloads and SQLite TaskRun history; no path or content exported"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn paths() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::Builder::new()
            .prefix("atools-fixture-environment-")
            .tempdir()
            .unwrap();
        let base = std::fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        std::fs::create_dir(&home).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let downloads = home.join("Downloads");
        (root, home, downloads)
    }
    #[test]
    fn published_paths_abort_unless_native_downloads_is_the_owned_private_home_child() {
        let (_root, home, downloads) = paths();
        assert!(validate_downloads(&home, &downloads).is_ok());
        assert!(validate_downloads(&home, &home.join("other")).is_err());
        assert!(
            validate_downloads(Path::new("/Users/real"), Path::new("/Users/real/Downloads"))
                .is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&home, &downloads).unwrap();
            assert!(validate_downloads(&home, &downloads).is_err());
        }
    }
    #[test]
    fn converted_deepread_prepares_only_the_fixed_file_under_private_home_without_path_access() {
        let (_root, home, downloads) = paths();
        let profile = json!({"caseId":super::super::deepread_fixture::CASE_ID,"id":"deepread",
            "title":"DeepRead 深读","runtime":"web","pathAccess":"none",
            "dialogAccess":"open","dataAccess":true});
        let prepared = prepare_deepread_fixture(
            &profile,
            &home,
            &downloads,
            super::super::deepread_fixture::TextEncoding::Ascii,
        )
        .unwrap()
        .unwrap();
        assert_eq!(prepared, downloads);
        let evidence = super::super::deepread_fixture::evidence(
            &prepared.join(super::super::deepread_fixture::FILE_NAME),
            &profile,
            super::super::deepread_fixture::TextEncoding::Ascii,
        )
        .unwrap();
        assert_eq!(
            evidence["fileName"],
            super::super::deepread_fixture::FILE_NAME
        );
        assert_eq!(evidence["bytes"], 8856);
        assert_eq!(
            evidence["sha256"],
            "81f1d61593517a97f8f206e0df298e45bdabeaa99fc99d32009eb3b80c50ac83"
        );
        assert_eq!(evidence["readOnly"], true);
        assert!(!evidence.to_string().contains(home.to_str().unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&downloads).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn converted_deepread_bom_variant_is_prepared_only_as_the_explicit_fixed_input() {
        let (_root, home, downloads) = paths();
        let profile = json!({"caseId":super::super::deepread_fixture::CASE_ID,"id":"deepread",
            "title":"DeepRead 深读","runtime":"web","pathAccess":"none",
            "dialogAccess":"open","dataAccess":true});
        let prepared = prepare_deepread_fixture(
            &profile,
            &home,
            &downloads,
            super::super::deepread_fixture::TextEncoding::Utf8Bom,
        )
        .unwrap()
        .unwrap();
        let evidence = super::super::deepread_fixture::evidence(
            &prepared.join(super::super::deepread_fixture::FILE_NAME),
            &profile,
            super::super::deepread_fixture::TextEncoding::Utf8Bom,
        )
        .unwrap();
        assert_eq!(evidence["bytes"], 8859);
        assert_eq!(evidence["textEncoding"], "utf8-bom");
        assert_eq!(evidence["storedContentBytes"], 8854);
        assert_eq!(
            evidence["storedContentSha256"],
            "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0"
        );
        assert!(!evidence.to_string().contains(home.to_str().unwrap()));
    }

    #[test]
    fn converted_deepread_fixture_rejects_path_permission_promotion_and_other_cases() {
        let (_root, home, downloads) = paths();
        let wrong_case = json!({"caseId":"other","pathAccess":"none"});
        assert!(prepare_deepread_fixture(
            &wrong_case,
            &home,
            &downloads,
            super::super::deepread_fixture::TextEncoding::Utf8Bom
        )
        .unwrap()
        .is_none());
        let promoted = json!({"caseId":super::super::deepread_fixture::CASE_ID,"id":"deepread",
            "runtime":"web","pathAccess":"standard","dialogAccess":"open","dataAccess":true});
        assert!(prepare_deepread_fixture(
            &promoted,
            &home,
            &downloads,
            super::super::deepread_fixture::TextEncoding::Utf8Bom
        )
        .is_err());
        assert!(!downloads.exists());
    }

    #[test]
    fn published_paths_evidence_reads_real_bytes_without_exporting_private_fields() {
        let (_root, home, downloads) = paths();
        std::fs::create_dir(&downloads).unwrap();
        let db = Database::in_memory().unwrap();
        let profile = json!({"caseId":"regex-editor","pathAccess":"standard"});
        let empty = evidence(&db, &profile, Some(&downloads)).unwrap();
        assert_eq!(empty["fileCount"], 0);
        assert_eq!(empty["contentMatches"], false);
        std::fs::write(downloads.join("123456789.txt"), CONTENT).unwrap();
        let observed = evidence(&db, &profile, Some(&downloads)).unwrap();
        assert_eq!(observed["contentMatches"], true);
        assert_eq!(observed["actualBytes"], CONTENT.len());
        assert!(!observed.to_string().contains(home.to_str().unwrap()));
        assert!(!observed
            .to_string()
            .contains("ATOOLS_PATH_SNAPSHOT_SYNTHETIC"));
        std::fs::write(downloads.join("unexpected.bin"), b"unexpected").unwrap();
        assert!(evidence(&db, &profile, Some(&downloads)).is_err());
    }

    fn image_stitch_profile() -> Value {
        json!({"caseId":"local-image-stitch-head","id":"image-stitch","version":"1.0.0",
            "featureCode":"image-stitch-files","runtime":"web","dataAccess":true,
            "dialogAccess":"open_and_save","pathAccess":"none","verifyDataPersistence":false,
            "sourceKind":"local_full_directory","sourceCommit":"2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
            "sourceTree":"629b6c70b86f28d8f775ced7202bfc2de9b244d5",
            "directorySha256":"16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee",
            "fileCount":5})
    }

    #[test]
    fn image_stitch_pair_is_prepared_only_under_the_exact_private_downloads_root() {
        let (_root, home, downloads) = paths();
        let prepared = prepare_image_stitch_fixture(&image_stitch_profile(), &home, &downloads)
            .unwrap()
            .unwrap();
        assert_eq!(prepared, downloads);
        let report = image_stitch_fixture(
            &image_stitch_profile(),
            Some(&prepared),
            "4be0643f-1d98-4f20-a423-70a0a8a8c144",
        )
        .unwrap();
        assert_eq!(
            report["files"][0]["fileName"],
            "atools-image-stitch-top.png"
        );
        assert_eq!(
            report["files"][1]["fileName"],
            "atools-image-stitch-bottom.png"
        );
        assert_eq!(report["pathAccess"], "none");
    }

    #[test]
    fn image_stitch_rejects_wrong_profile_foreign_root_and_downloads_symlink() {
        let (_root, home, downloads) = paths();
        let mut promoted = image_stitch_profile();
        promoted["pathAccess"] = json!("standard");
        assert!(prepare_image_stitch_fixture(&promoted, &home, &downloads).is_err());
        assert!(!downloads.exists());

        let outside = tempfile::tempdir().unwrap();
        let outside_home = outside.path().join("home");
        std::fs::create_dir(&outside_home).unwrap();
        assert!(prepare_image_stitch_fixture(
            &image_stitch_profile(),
            &outside_home,
            &outside_home.join("Downloads")
        )
        .is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let (_root, home, downloads) = paths();
            let target = home.join("real-downloads");
            std::fs::create_dir(&target).unwrap();
            symlink(&target, &downloads).unwrap();
            assert!(
                prepare_image_stitch_fixture(&image_stitch_profile(), &home, &downloads).is_err()
            );
            assert!(std::fs::read_dir(target).unwrap().next().is_none());
        }
    }
}
