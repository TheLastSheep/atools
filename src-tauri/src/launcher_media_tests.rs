use super::*;
use atools_core::Plugin;
use serde_json::json;
use std::sync::Arc;

fn db() -> Database {
    let db = Database::in_memory().unwrap();
    let plugin=Plugin{id:"media".into(),name:"media".into(),version:"1".into(),path:"/not-executed".into(),enabled:true,created_at:"now".into(),updated_at:"now".into(),manifest:serde_json::from_value(json!({"name":"media","title":"媒体工具","features":[
        {"code":"files","label":"文件处理","cmds":["file-alias",{"type":"files","fileType":"file","extensions":["txt"],"label":"TXT内容"}]},
        {"code":"folders","cmds":[{"type":"files","fileType":"directory"}]},
        {"code":"image","cmds":["image-alias",{"type":"img"}]},
        {"code":"text","cmds":["files",{"type":"over"}]}
    ]})).unwrap()};
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    db
}
#[test]
fn file_metadata_is_derived_from_host_and_exact_order_duplicates_are_retained() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("PRIVATE_SELECTED_😀.txt");
    let directory = temp.path().join("folder");
    std::fs::write(&file, "fixture").unwrap();
    std::fs::create_dir(&directory).unwrap();
    let paths = vec![
        file.to_str().unwrap().into(),
        directory.to_str().unwrap().into(),
        file.to_str().unwrap().into(),
    ];
    let result = files::validate_paths(&paths).unwrap();
    assert_eq!(
        result.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        paths
    );
    assert_eq!(result[0].name, "PRIVATE_SELECTED_😀.txt");
    assert!(result[0].is_file);
    assert!(result[1].is_directory);
    assert_eq!(result[0], result[2]);
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json[0]["isFile"], true);
    assert_eq!(json[1]["isDirectory"], true);
}
#[test]
fn paths_are_all_preflighted_and_unavailable_or_relative_entries_fail_without_path_disclosure() {
    let temp = tempfile::tempdir().unwrap();
    let private = temp
        .path()
        .join("PRIVATE_MISSING_NAME.txt")
        .to_str()
        .unwrap()
        .to_string();
    for paths in [
        vec![],
        vec!["relative_PRIVATE_NAME".into()],
        vec![private.clone()],
        vec!["/PRIVATE_NUL\0".into()],
        vec![format!("/{}", "x".repeat(8192))],
        vec!["/x".into(); 1001],
    ] {
        let error = files::validate_paths(&paths).unwrap_err();
        for marker in ["PRIVATE_", &private, "relative_"] {
            assert!(!error.contains(marker));
        }
    }
}
#[test]
fn activation_restats_current_selection_and_rechecks_typed_owner_and_dynamic_catalogue() {
    let db = db();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("PRIVATE_CURRENT.txt");
    std::fs::write(&path, "body").unwrap();
    let paths = vec![path.to_str().unwrap().to_string()];
    let before = db.feature_catalog_snapshot().unwrap();
    let selection = files::validate_paths(&paths).unwrap();
    let candidates = crate::launcher_catalog::search_file_content(&db, &selection, None).unwrap();
    assert_eq!(candidates.len(), 1);
    for alias in ["媒体工具", "文件处理", "file-alias", "TXT内容"] {
        assert!(candidates[0]
            .content_search_terms
            .iter()
            .any(|term| term == alias));
    }
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    let (payload, kind) = validate_payload(&db, "files", json!(paths), "media", "files").unwrap();
    assert_eq!(kind, "files");
    assert_eq!(payload[0]["name"], "PRIVATE_CURRENT.txt");
    assert!(validate_payload(&db, "files", json!(paths), "wrong-owner", "files").is_err());
    assert!(validate_payload(&db, "text", json!(paths), "media", "files").is_err());
    std::fs::remove_file(&path).unwrap();
    assert!(
        validate_payload(&db, "files", json!(paths), "media", "files")
            .unwrap_err()
            .starts_with("FILE_INPUT_UNAVAILABLE:")
    );
    std::fs::create_dir(&path).unwrap();
    assert!(
        validate_payload(&db, "files", json!(paths), "media", "files")
            .unwrap_err()
            .starts_with("MEDIA_CONTENT_NOT_MATCHED:")
    );
    let (payload, _) = validate_payload(&db, "folders", json!(paths), "media", "files").unwrap();
    assert_eq!(payload[0]["isDirectory"], true);
    let mut plugin = db.get_plugin("media").unwrap();
    plugin.enabled = false;
    db.save_plugin(&plugin).unwrap();
    assert!(validate_payload(&db, "folders", json!(paths), "media", "files").is_err());
}
#[cfg(unix)]
#[test]
fn absolute_symlinks_preserve_selected_path_and_broken_or_special_files_reject() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("file.txt");
    let link = temp.path().join("link.txt");
    std::fs::write(&target, "body").unwrap();
    symlink(&target, &link).unwrap();
    let paths = vec![link.to_str().unwrap().to_string()];
    let result = files::validate_paths(&paths).unwrap();
    assert_eq!(result[0].path, paths[0]);
    assert_eq!(result[0].name, "link.txt");
    assert!(result[0].is_file);
    std::fs::remove_file(&target).unwrap();
    assert!(files::validate_paths(&paths).is_err());
    let non_utf8 = temp.path().join(std::ffi::OsString::from_vec(vec![0xff]));
    assert!(clipboard_path(&non_utf8)
        .unwrap_err()
        .starts_with("FILE_INPUT_INVALID:"));
    let fifo = temp.path().join("PRIVATE_FIFO");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let error = files::validate_paths(&[fifo.to_str().unwrap().into()]).unwrap_err();
    assert!(error.starts_with("FILE_INPUT_UNSUPPORTED:"));
    assert!(!error.contains("PRIVATE_FIFO"));
}
#[test]
fn image_projection_and_live_activation_preserve_original_url_without_using_path_heuristics() {
    use base64::Engine;
    let db = db();
    let mut bytes = std::io::Cursor::new(Vec::new());
    ::image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut bytes, ::image::ImageFormat::Png)
        .unwrap();
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.get_ref())
    );
    let result = crate::launcher_catalog::search_image_content(&db, None).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].result.code, "image");
    assert_eq!(result[0].result.match_type, "img");
    let (payload, kind) = validate_payload(&db, "image", json!(url), "media", "img").unwrap();
    assert_eq!(payload, json!(url));
    assert_eq!(kind, "img");
    assert!(validate_payload(&db, "image", json!("/PRIVATE_IMAGE.png"), "media", "img").is_err());
    assert!(validate_payload(&db, "text", json!(url), "media", "img").is_err());
}
