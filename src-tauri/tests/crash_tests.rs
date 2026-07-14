use atools_core::config::AppConfig;
use atools_lib::crash::{
    clear_crash_log, crash_log_path, export_crash_log, format_panic_log_entry, list_crash_logs,
};
use std::path::PathBuf;

#[test]
fn crash_log_path_uses_app_base_dir() {
    let config = AppConfig::with_base_dir(PathBuf::from("/tmp/atools-crash-test"));

    assert_eq!(
        crash_log_path(&config),
        PathBuf::from("/tmp/atools-crash-test/crashes.log")
    );
}

#[test]
fn format_panic_log_entry_records_payload_location_and_timestamp() {
    let entry = format_panic_log_entry(
        "2026-06-02T13:00:00Z",
        "panic payload",
        Some("src/lib.rs:42"),
    );

    assert!(entry.contains("2026-06-02T13:00:00Z"));
    assert!(entry.contains("panic payload"));
    assert!(entry.contains("src/lib.rs:42"));
    assert!(entry.ends_with("\n"));
}

#[test]
fn list_export_and_clear_crash_logs_use_real_file() {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    let log_path = crash_log_path(&config);
    std::fs::write(
        &log_path,
        [
            "[2026-06-02T13:00:00Z] panic: first panic at src/lib.rs:10",
            "[2026-06-02T13:01:00Z] panic: second panic at src/main.rs:20",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let entries = list_crash_logs(&config, 1).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].timestamp, "2026-06-02T13:01:00Z");
    assert!(entries[0].message.contains("second panic"));
    assert_eq!(entries[0].location.as_deref(), Some("src/main.rs:20"));

    let exported = export_crash_log(&config).unwrap();
    assert!(exported.contains("first panic"));
    assert!(exported.contains("second panic"));

    assert_eq!(clear_crash_log(&config).unwrap(), 2);
    assert_eq!(export_crash_log(&config).unwrap(), "");
    assert!(list_crash_logs(&config, 10).unwrap().is_empty());
}
