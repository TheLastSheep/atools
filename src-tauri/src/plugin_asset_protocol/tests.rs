use super::*;
use crate::plugin_code_revision::CodeRevision;
use std::{fs, path::PathBuf};

fn database(root: &std::path::Path) -> Database {
    let db = Database::in_memory().unwrap();
    let plugin = serde_json::from_value(serde_json::json!({"id":"resource-fixture","name":"fixture","version":"1",
        "path":root,"enabled":true,"manifest":{"name":"resource-fixture","version":"1","main":"index.html"},
        "created_at":"now","updated_at":"now"})).unwrap();
    db.save_plugin(&plugin).unwrap();
    db
}

fn fixture() -> (tempfile::TempDir, Database, Arc<Resources>, Lease) {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("entry.js"), b"export const answer=42;").unwrap();
    let db = database(temp.path());
    let resources = Arc::new(Resources::default());
    let owner = Owner::new(
        "main",
        "resource-fixture",
        &uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let prepared = resources
        .prepare(owner, authorization(&db, "resource-fixture").unwrap())
        .unwrap();
    let lease = resources.get(&prepared.session_id, "main").unwrap();
    (temp, db, resources, lease)
}

fn parse(lease: &Lease, suffix: &str, method: &str) -> request::ResourceRequest {
    request::parse(
        &Request::builder()
            .method(method)
            .uri(format!("atools-plugin://localhost/{}/{suffix}", lease.id))
            .body(Vec::new())
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn plugin_asset_protocol_serves_real_bytes_and_head_with_opaque_cors() {
    let (_temp, db, _resources, lease) = fixture();
    let response = read_resource(
        &db,
        &lease,
        &parse(&lease, "entry.js?cache=1&path=outside", "GET"),
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"export const answer=42;");
    assert_eq!(response.headers()["access-control-allow-origin"], "null");
    assert_eq!(response.headers()["vary"], "Origin");
    assert_eq!(
        response.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let head = read_resource(&db, &lease, &parse(&lease, "entry.js", "HEAD"));
    assert!(head.body().is_empty());
    assert_eq!(head.headers()["content-length"], "23");
    let options = read_resource(&db, &lease, &parse(&lease, "entry.js", "OPTIONS"));
    assert_eq!(options.status(), StatusCode::NO_CONTENT);
    assert!(options.body().is_empty());
    assert_eq!(
        read_resource(&db, &lease, &parse(&lease, "missing.js", "GET")).status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn plugin_asset_protocol_refuses_disabled_changed_revisions_and_root_rebinding() {
    let (_temp, db, resources, lease) = fixture();
    let mut plugin = db.get_plugin("resource-fixture").unwrap();
    plugin.enabled = false;
    db.save_plugin(&plugin).unwrap();
    assert!(authorization(&db, "resource-fixture").is_err());
    assert_eq!(
        read_resource(&db, &lease, &parse(&lease, "entry.js", "GET")).status(),
        StatusCode::FORBIDDEN
    );
    plugin.enabled = true;
    db.save_plugin(&plugin).unwrap();
    CodeRevision::begin(&db, "resource-fixture")
        .unwrap()
        .finish(&db)
        .unwrap();
    assert_eq!(
        read_resource(&db, &lease, &parse(&lease, "entry.js", "GET")).status(),
        StatusCode::FORBIDDEN
    );
    resources.invalidate_plugin("resource-fixture");
    assert!(resources.get(&lease.id, "main").is_none());
    let owner = lease.owner.clone();
    let prepared = resources
        .prepare(owner, authorization(&db, "resource-fixture").unwrap())
        .unwrap();
    let current = resources.get(&prepared.session_id, "main").unwrap();
    let other = tempfile::tempdir().unwrap();
    plugin.path = other.path().to_string_lossy().into();
    db.save_plugin(&plugin).unwrap();
    assert_eq!(
        read_resource(&db, &current, &parse(&current, "entry.js", "GET")).status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn plugin_asset_protocol_incomplete_revision_never_prepares_a_lease() {
    let (_temp, db, _resources, _lease) = fixture();
    let _changing = CodeRevision::begin(&db, "resource-fixture").unwrap();
    assert!(authorization(&db, "resource-fixture").is_err());
}

#[test]
fn plugin_asset_protocol_owns_lease_by_window_plugin_and_instance_and_enforces_caps() {
    let (_temp, _db, resources, lease) = fixture();
    assert!(resources.get(&lease.id, "foreign-window").is_none());
    assert_eq!(
        resources.get_for_owner(&lease.id, &lease.owner).unwrap().id,
        lease.id
    );
    let mut foreign = lease.owner.clone();
    foreign.instance = uuid::Uuid::new_v4().to_string();
    assert!(resources.get_for_owner(&lease.id, &foreign).is_none());
    resources.close(&foreign);
    assert!(resources.get(&lease.id, "main").is_some());
    let reused = resources
        .prepare(lease.owner.clone(), lease.authorization.clone())
        .unwrap();
    assert_eq!(reused.session_id, lease.id);
    for _ in 0..3 {
        let mut owner = lease.owner.clone();
        owner.instance = uuid::Uuid::new_v4().to_string();
        resources
            .prepare(owner, lease.authorization.clone())
            .unwrap();
    }
    let mut fifth = lease.owner.clone();
    fifth.instance = uuid::Uuid::new_v4().to_string();
    assert!(resources
        .prepare(fifth, lease.authorization.clone())
        .is_err());
    for window in 1..8 {
        for _ in 0..4 {
            let mut owner = lease.owner.clone();
            owner.window = format!("window-{window}");
            owner.instance = uuid::Uuid::new_v4().to_string();
            resources
                .prepare(owner, lease.authorization.clone())
                .unwrap();
        }
    }
    assert_eq!(resources.count(), 32);
    let mut extra = lease.owner.clone();
    extra.window = "ninth".into();
    assert!(resources
        .prepare(extra, lease.authorization.clone())
        .is_err());
    resources.close_window("main");
    assert_eq!(resources.count(), 28);
    assert!(resources
        .if_current(&lease, || panic!("Closed lease must not hand off bytes"))
        .is_none());
    resources.invalidate_plugin("resource-fixture");
    assert_eq!(resources.count(), 0);
}

#[test]
fn plugin_asset_protocol_url_decodes_each_segment_once_and_never_uses_query_as_path() {
    let (temp, db, _resources, lease) = fixture();
    fs::write(temp.path().join("literal%2e.js"), b"literal").unwrap();
    let once = parse(&lease, "literal%252e.js?x=%2f..%2f.env", "GET");
    assert_eq!(once.relative, PathBuf::from("literal%2e.js"));
    assert_eq!(read_resource(&db, &lease, &once).body(), b"literal");
    for suffix in [
        "../entry.js",
        "%2e%2e/entry.js",
        "assets//entry.js",
        "a%2fb.js",
        "a%5cb.js",
        "%00.js",
        "a:b.js",
        ".env",
        "credentials.json",
        "store.sqlite",
        "preload.node",
        "private.pem",
        "",
    ] {
        let request = Request::builder()
            .uri(format!("atools-plugin://localhost/{}/{suffix}", lease.id))
            .body(Vec::new())
            .unwrap();
        assert!(request::parse(&request).is_err(), "{suffix}");
    }
    for uri in [
        format!("atools-plugin://user@localhost/{}/entry.js", lease.id),
        format!("atools-plugin://elsewhere/{}/entry.js", lease.id),
        format!("https://outside.example/{}/entry.js", lease.id),
        "atools-plugin://localhost/not-a-uuid/entry.js".into(),
    ] {
        assert!(request::parse(&Request::builder().uri(uri).body(Vec::new()).unwrap()).is_err());
    }
    assert!(request::parse(
        &Request::builder()
            .method("POST")
            .uri(format!("atools-plugin://localhost/{}/entry.js", lease.id))
            .body(Vec::new())
            .unwrap()
    )
    .is_err());
}

#[test]
fn plugin_asset_protocol_preserves_ordinary_queries_and_extracts_one_document_token() {
    let (_temp, _db, _resources, lease) = fixture();
    let document_id = "ab".repeat(32);
    let parsed = parse(
        &lease,
        &format!("index.html?id=snipaste&windowRole=child&__atools_window_document={document_id}"),
        "GET",
    );
    assert_eq!(
        parsed.window_document.as_deref(),
        Some(document_id.as_str())
    );
    assert_eq!(parsed.relative, PathBuf::from("index.html"));

    let ordinary = parse(&lease, "entry.js?id=snipaste&windowRole=child", "GET");
    assert_eq!(ordinary.window_document, None);
    let queries = vec![
        "__atools_window_document=invalid".to_owned(),
        format!("__atools_window_document={document_id}&__atools_window_document={document_id}"),
        format!(
            "%5f%5fatools_window_document={document_id}&__atools_window_document={document_id}"
        ),
    ];
    for query in queries {
        let request = Request::builder()
            .uri(format!(
                "atools-plugin://localhost/{}/index.html?{query}",
                lease.id
            ))
            .body(Vec::new())
            .unwrap();
        assert!(request::parse(&request).is_err(), "{query}");
    }
}

#[test]
fn plugin_asset_protocol_rejects_oversized_files_and_nonregular_resources() {
    let (temp, db, _resources, lease) = fixture();
    fs::File::create(temp.path().join("large.js"))
        .unwrap()
        .set_len(MAX_RESOURCE_BYTES as u64 + 1)
        .unwrap();
    assert_eq!(
        read_resource(&db, &lease, &parse(&lease, "large.js", "GET")).status(),
        StatusCode::FORBIDDEN
    );
    fs::create_dir(temp.path().join("directory.js")).unwrap();
    assert_eq!(
        read_resource(&db, &lease, &parse(&lease, "directory.js", "GET")).status(),
        StatusCode::FORBIDDEN
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(temp.path().join("entry.js"), temp.path().join("alias.js")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.js"), b"outside").unwrap();
        symlink(outside.path(), temp.path().join("linked")).unwrap();
        for path in ["alias.js", "linked/outside.js"] {
            assert_eq!(
                read_resource(&db, &lease, &parse(&lease, path, "GET")).status(),
                StatusCode::FORBIDDEN
            );
        }
    }
}

#[tokio::test]
async fn plugin_asset_protocol_reset_waits_for_inflight_read_and_suppresses_late_delivery() {
    let (_temp, _db, resources, lease) = fixture();
    let gates = Arc::new(crate::plugin_execution_gates::PluginExecutionGates::default());
    let read = gates.read("resource-fixture").await;
    let writer_resources = resources.clone();
    let writer_gates = gates.clone();
    let writer = tokio::spawn(async move {
        let _write = writer_gates.write("resource-fixture").await;
        writer_resources.invalidate_plugin("resource-fixture");
    });
    tokio::task::yield_now().await;
    assert!(!writer.is_finished());
    assert_eq!(
        resources.if_current(&lease, || "handoff-before-reset"),
        Some("handoff-before-reset")
    );
    drop(read);
    writer.await.unwrap();
    assert!(resources
        .if_current(&lease, || panic!("No old bytes after reset"))
        .is_none());
    // Close does not wait for a read gate, so it must also cancel final handoff.
    let current = resources
        .prepare(lease.owner.clone(), lease.authorization.clone())
        .unwrap();
    let current = resources.get(&current.session_id, "main").unwrap();
    resources.close(&current.owner);
    assert!(resources
        .if_current(&current, || panic!("No old bytes after close"))
        .is_none());
}

#[tokio::test]
async fn plugin_asset_protocol_bounds_concurrency_without_rejecting_a_ninth_parallel_chunk() {
    let resources = Arc::new(Resources::default());
    let mut reads = Vec::new();
    for _ in 0..8 {
        reads.push(resources.reads.clone().acquire_owned().await.unwrap());
    }
    let queued = resources.reads.clone().acquire_owned();
    tokio::pin!(queued);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut queued)
            .await
            .is_err()
    );
    reads.pop();
    assert!(queued.await.is_ok());
    let mut pending = Vec::new();
    for _ in 0..64 {
        pending.push(resources.pending.clone().try_acquire_owned().unwrap());
    }
    assert!(resources.pending.clone().try_acquire_owned().is_err());
    drop(pending);
    assert_eq!(resources.pending.available_permits(), 64);
}

#[test]
fn plugin_asset_protocol_cancelled_preparations_cannot_revive_closed_windows_instances_or_plugins()
{
    let (_temp, _db, resources, lease) = fixture();
    for kind in ["window", "owner", "plugin"] {
        let pending = resources.begin(lease.owner.clone()).unwrap();
        match kind {
            "window" => resources.close_window("main"),
            "owner" => resources.close(&lease.owner),
            _ => resources.invalidate_plugin("resource-fixture"),
        }
        assert!(
            resources
                .commit(pending, lease.authorization.clone())
                .is_err(),
            "{kind}"
        );
        assert_eq!(resources.count(), 0);
    }
    // A future live generation may reuse a label/owner; cancellation only affects
    // tickets already issued, so no unbounded epoch tombstones are retained.
    let fresh = resources.begin(lease.owner.clone()).unwrap();
    assert!(resources.commit(fresh, lease.authorization.clone()).is_ok());
    let mut pending = Vec::new();
    for _ in 0..64 {
        pending.push(resources.begin(lease.owner.clone()).unwrap());
    }
    assert!(resources.begin(lease.owner.clone()).is_err());
    drop(pending);
    assert!(resources.begin(lease.owner).is_ok());
}
