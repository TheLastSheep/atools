use super::delivery::next_revision;
use super::*;
use atools_core::db::{Database, RendererLocalShortcutMutation};
use std::sync::atomic::AtomicUsize;

const SESSION: &str = "00000000000040008000000000000001";

fn identity() -> ChildIdentity {
    ChildIdentity {
        session_id: SESSION.into(),
        label: format!("ztools-settings-{SESSION}"),
        bundle_revision: "bundle-r1".into(),
    }
}

fn target(identity: &ChildIdentity) -> TargetSnapshot {
    TargetSnapshot {
        session_id: identity.session_id.clone(),
        label: identity.label.clone(),
        origin: format!("atools-settings://{}.localhost", identity.session_id),
        bundle_revision: identity.bundle_revision.clone(),
        current_bundle_revision: identity.bundle_revision.clone(),
        webview_label: identity.label.clone(),
        parent_label: "main".into(),
        phase: SessionPhase::Open,
        ready: true,
        revoked: false,
    }
}

fn route(fragment: &str) -> tauri::Url {
    tauri::Url::parse(&format!(
        "atools-settings://{SESSION}.localhost/index.html#{fragment}"
    ))
    .unwrap()
}

fn valid_paths(paths: &[PathBuf]) -> Vec<String> {
    validate_paths(paths).unwrap()
}

pub(super) fn add_path_to_database(database: &Database, path: String) -> PathOutcome {
    let Ok(super::super::local_shortcut_protocol::Request::AddByPath(path)) =
        super::super::local_shortcut_protocol::parse_request(
            "addLocalShortcutByPath",
            &json!({"path":path}),
        )
    else {
        return PathOutcome::Failed;
    };
    let Ok(record) =
        super::super::local_shortcut_files::build_record(path, uuid::Uuid::new_v4().to_string())
    else {
        return PathOutcome::Failed;
    };
    match database.apply_renderer_local_shortcut_guarded(
        RendererLocalShortcutMutation::Add { record },
        || true,
    ) {
        Ok(write) if write.changed => PathOutcome::Added,
        _ => PathOutcome::Failed,
    }
}

#[test]
fn target_gate_binds_session_revision_real_child_parent_phase_and_local_launch_route() {
    let identity = identity();
    let good = target(&identity);
    assert!(target_matches(&identity, &good, &route("/localLaunch")));
    assert!(target_matches(
        &identity,
        &good,
        &route("/localLaunch?_t=1710000000000")
    ));

    let mut wrong = good.clone();
    wrong.session_id = "00000000000040008000000000000002".into();
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.webview_label = "main".into();
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.parent_label = "plugin-child".into();
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.current_bundle_revision = "bundle-r2".into();
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.phase = SessionPhase::Closing;
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.ready = false;
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    let mut wrong = good.clone();
    wrong.revoked = true;
    assert!(!target_matches(&identity, &wrong, &route("/localLaunch")));
    assert!(!target_matches(&identity, &good, &route("/generalSetting")));
}

#[test]
fn whole_batch_path_validation_enforces_count_utf8_absolute_and_byte_limits() {
    let exact_path = format!("/{}", "x".repeat(MAX_DROP_PATH_BYTES - 1));
    assert_eq!(
        validate_paths(&[PathBuf::from(&exact_path)]).unwrap()[0].len(),
        MAX_DROP_PATH_BYTES
    );
    let exact_total = vec![PathBuf::from(&exact_path); 4];
    assert_eq!(
        valid_paths(&exact_total)
            .iter()
            .map(String::len)
            .sum::<usize>(),
        MAX_DROP_TOTAL_BYTES
    );

    let mut too_much_total = exact_total;
    too_much_total.push(PathBuf::from("/x"));
    assert!(validate_paths(&too_much_total).is_err());
    assert!(validate_paths(&[PathBuf::from("/"), PathBuf::from("relative")]).is_err());
    assert!(validate_paths(&[PathBuf::from(format!(
        "/{}",
        "x".repeat(MAX_DROP_PATH_BYTES)
    ))])
    .is_err());
    assert!(validate_paths(&[PathBuf::from("/tmp/a\0b")]).is_err());
    assert!(validate_paths(&[PathBuf::from("/tmp/a\nb")]).is_err());
    assert!(validate_paths(&vec![PathBuf::from("/x"); MAX_DROP_PATHS]).is_ok());
    assert!(validate_paths(&vec![PathBuf::from("/x"); MAX_DROP_PATHS + 1]).is_err());
    assert!(validate_paths(&[]).is_err());
}

#[cfg(unix)]
#[test]
fn path_validation_rejects_non_utf8_native_paths_without_lossy_conversion() {
    use std::os::unix::ffi::OsStringExt;
    assert!(
        validate_paths(&[PathBuf::from(std::ffi::OsString::from_vec(vec![
            b'/', 0xff
        ]))])
        .is_err()
    );
}

#[tokio::test]
async fn actual_batch_executor_writes_multiple_core_rows_and_counts_duplicates_and_missing_paths() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.txt");
    let second = directory.path().join("second.txt");
    std::fs::write(&first, "1").unwrap();
    std::fs::write(&second, "2").unwrap();
    let missing = directory.path().join("missing.txt");
    let paths = valid_paths(&[first.clone(), second, first.clone(), missing]);
    let database = Arc::new(Database::in_memory().unwrap());
    let counts = execute_path_batch(
        &paths,
        || true,
        |path| {
            let database = Arc::clone(&database);
            async move { add_path_to_database(&database, path) }
        },
    )
    .await;
    assert_eq!(
        counts,
        DropCounts {
            added: 2,
            failed: 2
        }
    );
    let rows = database.read_renderer_local_shortcuts().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.path == first.to_str().unwrap()));
}

#[tokio::test]
async fn route_leave_stops_unstarted_paths_and_close_guard_rejects_the_current_write() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.txt");
    let second = directory.path().join("second.txt");
    std::fs::write(&first, "1").unwrap();
    std::fs::write(&second, "2").unwrap();
    let paths = valid_paths(&[first, second]);
    let database = Arc::new(Database::in_memory().unwrap());
    let still_current = Arc::new(AtomicBool::new(true));
    let is_current = Arc::clone(&still_current);
    let counts = execute_path_batch(
        &paths,
        || is_current.load(Ordering::Acquire),
        |path| {
            let database = Arc::clone(&database);
            let still_current = Arc::clone(&still_current);
            async move {
                let Ok(record) = super::super::local_shortcut_files::build_record(
                    path,
                    uuid::Uuid::new_v4().to_string(),
                ) else {
                    return PathOutcome::Failed;
                };
                let write = database.apply_renderer_local_shortcut_guarded(
                    RendererLocalShortcutMutation::Add { record },
                    || still_current.load(Ordering::Acquire),
                );
                match write {
                    Ok(write) if write.changed => {
                        still_current.store(false, Ordering::Release);
                        PathOutcome::Added
                    }
                    _ => PathOutcome::Failed,
                }
            }
        },
    )
    .await;
    assert_eq!(
        counts,
        DropCounts {
            added: 1,
            failed: 1
        }
    );
    assert_eq!(database.read_renderer_local_shortcuts().unwrap().len(), 1);

    let closing_db = Arc::new(Database::in_memory().unwrap());
    let closing_file = directory.path().join("closing.txt");
    std::fs::write(&closing_file, "3").unwrap();
    let closing_paths = valid_paths(&[closing_file]);
    let closed = Arc::new(AtomicBool::new(true));
    let counts = execute_path_batch(
        &closing_paths,
        || true,
        |path| {
            let db = Arc::clone(&closing_db);
            let closed = Arc::clone(&closed);
            async move {
                let Ok(record) = super::super::local_shortcut_files::build_record(
                    path,
                    uuid::Uuid::new_v4().to_string(),
                ) else {
                    return PathOutcome::Failed;
                };
                match db.apply_renderer_local_shortcut_guarded(
                    RendererLocalShortcutMutation::Add { record },
                    || !closed.load(Ordering::Acquire),
                ) {
                    Ok(write) if write.changed => PathOutcome::Added,
                    _ => PathOutcome::Failed,
                }
            }
        },
    )
    .await;
    assert_eq!(
        counts,
        DropCounts {
            added: 0,
            failed: 1
        }
    );
    assert!(closing_db
        .read_renderer_local_shortcuts()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn wrong_target_and_async_path_failures_do_not_create_database_rows() {
    let identity = identity();
    let snapshot = target(&identity);
    let path = PathBuf::from("/tmp/never-added.txt");
    let validated = valid_paths(&[path]);
    let database = Arc::new(Database::in_memory().unwrap());
    let attempts = Arc::new(AtomicUsize::new(0));
    let database_for_add = Arc::clone(&database);
    let attempts_for_add = Arc::clone(&attempts);
    let counts = execute_path_batch(
        &validated,
        || target_matches(&identity, &snapshot, &route("/generalSetting")),
        move |_| {
            let database = Arc::clone(&database_for_add);
            let attempts = Arc::clone(&attempts_for_add);
            async move {
                attempts.fetch_add(1, Ordering::Relaxed);
                add_path_to_database(&database, "/tmp/never-added.txt".into())
            }
        },
    )
    .await;
    assert_eq!(
        counts,
        DropCounts {
            added: 0,
            failed: 1
        }
    );
    assert_eq!(attempts.load(Ordering::Relaxed), 0);
    assert!(database.read_renderer_local_shortcuts().unwrap().is_empty());

    let rejected = execute_path_batch(&validated, || true, |_| async { PathOutcome::Failed }).await;
    assert_eq!(
        rejected,
        DropCounts {
            added: 0,
            failed: 1
        }
    );
}

#[test]
fn invalid_whole_batch_is_rejected_before_execution_and_single_flight_never_queues() {
    let database = Database::in_memory().unwrap();
    assert!(validate_paths(&[PathBuf::from("/tmp/good"), PathBuf::from("relative")]).is_err());
    assert!(database.read_renderer_local_shortcuts().unwrap().is_empty());

    let state = Arc::new(AtomicBool::new(false));
    let first = DropFlight::try_start(Arc::clone(&state)).unwrap();
    assert!(DropFlight::try_start(Arc::clone(&state)).is_none());
    drop(first);
    assert!(DropFlight::try_start(state).is_some());
}

#[test]
fn notice_has_exact_eight_keys_and_only_result_can_report_counts_or_flags() {
    let result = DropNotice {
        version: 1,
        session_id: SESSION.into(),
        revision: 1,
        phase: NoticePhase::Result,
        added: 2,
        failed: 1,
        busy: false,
        rejected: false,
    };
    let value = serde_json::to_value(&result).unwrap();
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 8);
    for key in [
        "version",
        "sessionId",
        "revision",
        "phase",
        "added",
        "failed",
        "busy",
        "rejected",
    ] {
        assert!(object.contains_key(key), "missing {key}");
    }
    assert!(result.valid());
    assert!(!DropNotice {
        busy: true,
        ..result.clone()
    }
    .valid());
    assert!(!DropNotice {
        rejected: true,
        ..result.clone()
    }
    .valid());
    assert!(!DropNotice {
        phase: NoticePhase::Enter,
        ..result
    }
    .valid());
}

#[test]
fn per_child_notice_revision_is_monotonic_and_stops_at_javascript_safe_limit() {
    let revisions = AtomicU64::new(0);
    assert_eq!(next_revision(&revisions), Some(1));
    assert_eq!(next_revision(&revisions), Some(2));
    let exhausted = AtomicU64::new(MAX_SAFE_INTEGER);
    assert_eq!(next_revision(&exhausted), None);
}

#[test]
fn native_drag_drop_event_sequence_notifies_hover_transitions_once() {
    let position = || tauri::PhysicalPosition::new(8.0, 12.0);
    let events = [
        DragDropEvent::Enter {
            paths: vec![PathBuf::from("/tmp/example.txt")],
            position: position(),
        },
        DragDropEvent::Over {
            position: position(),
        },
        DragDropEvent::Drop {
            paths: vec![PathBuf::from("/tmp/example.txt")],
            position: position(),
        },
        DragDropEvent::Enter {
            paths: vec![PathBuf::from("/tmp/example.txt")],
            position: position(),
        },
        DragDropEvent::Leave,
        DragDropEvent::Enter {
            paths: vec![PathBuf::from("/tmp/example.txt")],
            position: position(),
        },
        DragDropEvent::Enter {
            paths: vec![PathBuf::from("/tmp/example.txt")],
            position: position(),
        },
        DragDropEvent::Leave,
        DragDropEvent::Leave,
        DragDropEvent::Over {
            position: position(),
        },
    ];
    let expected = [
        Some(NoticePhase::Enter),
        None,
        Some(NoticePhase::Leave),
        Some(NoticePhase::Enter),
        Some(NoticePhase::Leave),
        Some(NoticePhase::Enter),
        None,
        Some(NoticePhase::Leave),
        None,
        None,
    ];
    let active = AtomicBool::new(false);
    let notices: Vec<_> = events
        .iter()
        .map(|event| hover_notice_for_event(&active, event))
        .collect();
    assert_eq!(notices, expected);
}
