//! Real activation persistence helpers with injected fixture media; no general clipboard access.
use super::*;
use atools_core::Plugin;
use serde_json::json;
fn db() -> Database {
    let db = Database::in_memory().unwrap();
    let plugin=Plugin{id:"media-audit".into(),name:"media-audit".into(),path:"/not-executed".into(),version:"1".into(),enabled:true,created_at:"now".into(),updated_at:"now".into(),manifest:serde_json::from_value(json!({"name":"media-audit","features":[{"code":"media-files","cmds":[{"type":"files"}]},{"code":"media-image","cmds":[{"type":"img"}]}]})).unwrap()};
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    db
}
fn assert_private(db: &Database, id: &str, secrets: &[&str], status: TaskRunStatus) {
    let run = db.get_task_run(id).unwrap().unwrap();
    assert_eq!(run.status, status);
    let json = serde_json::to_string(&run).unwrap();
    for secret in secrets {
        assert!(!json.contains(secret), "private value in durable field");
    }
    assert_eq!(run.input["payloadSummary"]["contentRedacted"], true);
}
#[test]
fn file_live_success_preserves_selection_and_task_output_contains_only_summary() {
    let db = db();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("PRIVATE_MEDIA_FILENAME.txt");
    std::fs::write(&path, "body").unwrap();
    let raw = json!([path.to_str().unwrap()]);
    let run = begin(&db, "media-files", &Some(raw.clone()), Some("media-audit")).unwrap();
    let id = run.id.clone();
    let mut action =
        resolve_checked(&db, "media-files", Some(raw.clone()), Some("media-audit")).unwrap();
    let (payload, kind) = crate::launcher_media::validate_payload(
        &db,
        "media-files",
        action.payload,
        "media-audit",
        "files",
    )
    .unwrap();
    action.payload = payload;
    action.entry_type = Some(kind);
    let action = finish(&db, "media-files", Instant::now(), run, Ok(action), |_| {}).unwrap();
    assert_eq!(action.entry_type, Some("files"));
    assert_eq!(action.payload[0]["path"], raw[0]);
    assert_eq!(action.payload[0]["name"], "PRIVATE_MEDIA_FILENAME.txt");
    assert_private(
        &db,
        &id,
        &["PRIVATE_MEDIA_FILENAME", path.to_str().unwrap(), "body"],
        TaskRunStatus::Succeeded,
    );
    assert_eq!(
        db.get_task_run(&id).unwrap().unwrap().output["payload_summary"]["contentRedacted"],
        true
    );
}
#[test]
fn removed_file_and_malformed_image_fail_terminally_without_leaking_paths_names_or_data() {
    let db = db();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("PRIVATE_REMOVED_FILENAME.txt");
    std::fs::write(&path, "body").unwrap();
    let paths = json!([path.to_str().unwrap()]);
    std::fs::remove_file(&path).unwrap();
    for (code, kind, raw) in [
        ("media-files", "files", paths),
        (
            "media-image",
            "img",
            json!("data:image/png;base64,PRIVATE_IMAGE_BODY"),
        ),
    ] {
        let run = begin(&db, code, &Some(raw.clone()), Some("media-audit")).unwrap();
        let id = run.id.clone();
        let error = crate::launcher_media::validate_payload(&db, code, raw, "media-audit", kind)
            .unwrap_err();
        assert!(
            finish(&db, code, Instant::now(), run, Err(error), |_| panic!(
                "failed validation cannot publish ready"
            ))
            .is_err()
        );
        assert_private(
            &db,
            &id,
            &[
                "PRIVATE_REMOVED_FILENAME",
                path.to_str().unwrap(),
                "PRIVATE_IMAGE_BODY",
                "data:image",
            ],
            TaskRunStatus::Failed,
        );
        assert!(db.get_task_run(&id).unwrap().unwrap().artifacts.is_empty());
    }
}
#[test]
fn image_live_success_retains_original_data_but_durable_task_is_redacted() {
    use base64::Engine;
    let db = db();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.get_ref())
    );
    let raw = json!(url);
    let run = begin(&db, "media-image", &Some(raw.clone()), Some("media-audit")).unwrap();
    let id = run.id.clone();
    let mut action =
        resolve_checked(&db, "media-image", Some(raw.clone()), Some("media-audit")).unwrap();
    let (payload, kind) = crate::launcher_media::validate_payload(
        &db,
        "media-image",
        action.payload,
        "media-audit",
        "img",
    )
    .unwrap();
    action.payload = payload;
    action.entry_type = Some(kind);
    let action = finish(&db, "media-image", Instant::now(), run, Ok(action), |_| {}).unwrap();
    assert_eq!(action.payload, raw);
    assert_eq!(action.entry_type, Some("img"));
    assert_private(
        &db,
        &id,
        &[&url, "data:image/png"],
        TaskRunStatus::Succeeded,
    );
}
