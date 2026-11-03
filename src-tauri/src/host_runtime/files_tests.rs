use super::{
    clipboard::ClipboardAccess,
    copied_files::{self, CopiedFile, MAX_FILES, MAX_PATH_BYTES, MAX_TOTAL_PATH_BYTES},
    registry::Access,
    request::ClipboardRequest,
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Files {
    items: Vec<CopiedFile>,
    reads: AtomicUsize,
}
impl ClipboardAccess for Files {
    fn read(&self) -> Result<String, String> {
        Ok(" exact \n".into())
    }
    fn write(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn read_files(&self) -> Result<Vec<CopiedFile>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.items.clone())
    }
}
fn backend(items: Vec<CopiedFile>) -> Files {
    Files {
        items,
        reads: AtomicUsize::new(0),
    }
}
fn item(path: String) -> CopiedFile {
    CopiedFile {
        name: "sample".into(),
        path,
        is_file: true,
        is_directory: false,
    }
}
#[test]
fn exact_payload_and_direction_contract_rejects_all_unrecognized_variants() {
    for value in [
        json!(null),
        json!([]),
        json!("files"),
        json!({"format":"text"}),
        json!({"format":null}),
        json!({"format":"Files"}),
        json!({"format":"files","text":"secret"}),
        json!({"method":"readFiles"}),
        json!({"format":"files","extra":true}),
    ] {
        assert!(ClipboardRequest::parse(Access::Read, &value).is_err());
    }
    for value in [
        json!({}),
        json!({"format":"files"}),
        json!({"text":"x","format":"files"}),
        json!({"text":null}),
        json!({"text":"x","method":"write"}),
    ] {
        assert!(ClipboardRequest::parse(Access::Write, &value).is_err());
    }
    let files = backend(vec![item("/space 文\nfile".into())]);
    let request = ClipboardRequest::parse(Access::Read, &json!({"format":"files"})).unwrap();
    assert!(request.execute(Access::Write, &files).is_err());
    assert_eq!(files.reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        request.execute(Access::Read, &files).unwrap()[0]["path"],
        "/space 文\nfile"
    );
    assert_eq!(
        ClipboardRequest::parse(Access::Read, &json!({}))
            .unwrap()
            .execute(Access::Read, &files)
            .unwrap(),
        " exact \n"
    );
    assert!(ClipboardRequest::parse(Access::Write, &json!({"text":""}))
        .unwrap()
        .execute(Access::Write, &files)
        .unwrap()
        .is_null());
}
#[test]
fn arrays_are_bounded_atomically_by_count_and_utf8_path_bytes() {
    assert_eq!(
        copied_files::exact_files(&backend(vec![])).unwrap(),
        json!([])
    );
    assert_eq!(
        copied_files::exact_files(&backend(vec![item("/x".into()); MAX_FILES]))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        MAX_FILES
    );
    assert!(copied_files::exact_files(&backend(vec![item("/x".into()); MAX_FILES + 1])).is_err());
    let boundary = format!("/{}", "x".repeat(MAX_PATH_BYTES - 1));
    assert!(copied_files::exact_files(&backend(vec![item(boundary.clone())])).is_ok());
    assert!(copied_files::exact_files(&backend(vec![item(format!("{boundary}x"))])).is_err());
    let multibyte = format!("/{}", "界".repeat(MAX_PATH_BYTES / 3 + 1));
    assert!(multibyte.chars().count() < MAX_PATH_BYTES);
    assert!(copied_files::exact_files(&backend(vec![item(multibyte)])).is_err());
    let total_boundary = vec![item(boundary.clone()); MAX_TOTAL_PATH_BYTES / MAX_PATH_BYTES];
    assert!(copied_files::exact_files(&backend(total_boundary.clone())).is_ok());
    let mut over = total_boundary;
    over.push(item("/x".into()));
    assert!(copied_files::exact_files(&backend(over)).is_err());
}
#[test]
fn encoded_response_budget_and_metadata_failures_never_return_partial_items() {
    let escaped = format!("/{}", "\u{1}".repeat(MAX_PATH_BYTES - 1));
    assert!(copied_files::exact_files(&backend(vec![item(escaped); 8])).is_err());
    for invalid in ["", "relative", "/private\0secret"] {
        let error =
            copied_files::exact_files(&backend(vec![item("/good".into()), item(invalid.into())]))
                .unwrap_err();
        assert!(!error.contains("secret") && !error.contains("/good"));
    }
    for (is_file, is_directory) in [(true, true), (false, false)] {
        let mut invalid = item("/good".into());
        invalid.is_file = is_file;
        invalid.is_directory = is_directory;
        assert!(copied_files::exact_files(&backend(vec![invalid])).is_err());
    }
    let mut invalid = item("/good".into());
    invalid.name.clear();
    assert!(copied_files::exact_files(&backend(vec![invalid])).is_err());
}
#[test]
fn paths_preserve_whitespace_unicode_and_real_metadata_without_reading_contents() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("  文 件\n🧰.txt");
    let directory = root.path().join("folder 空格\n");
    std::fs::write(&file, "never returned").unwrap();
    std::fs::create_dir(&directory).unwrap();
    let paths: Vec<_> = [&file, &directory]
        .into_iter()
        .map(|p| p.to_str().unwrap().to_string())
        .collect();
    let items = copied_files::describe_paths(paths.clone()).unwrap();
    assert_eq!(items[0].name, "  文 件\n🧰.txt");
    assert_eq!(items[1].name, "folder 空格\n");
    assert!(items[0].is_file && !items[0].is_directory);
    assert!(!items[1].is_file && items[1].is_directory);
    assert_eq!(
        items.iter().map(|i| i.path.clone()).collect::<Vec<_>>(),
        paths
    );
    assert!(copied_files::describe_paths(vec![
        file.to_str().unwrap().into(),
        root.path().join("missing-secret").to_str().unwrap().into()
    ])
    .unwrap_err()
    .contains("unavailable"));
}
#[test]
fn existing_backends_explicitly_reject_files_instead_of_fabricating_empty_success() {
    let (_, backend) = super::tests::fixture();
    assert_eq!(
        copied_files::exact_files(backend.as_ref()).unwrap_err(),
        "Native clipboard files are unsupported on this platform"
    );
}

#[test]
fn encoded_budget_counts_the_real_result_envelope_at_exact_boundary() {
    let mut files = vec![item(format!("/{}", "\u{1}".repeat(MAX_PATH_BYTES - 1))); 5];
    files.push(item("/x".into()));
    let body =
        |values: &[CopiedFile]| serde_json::to_vec(&json!({"ok":true,"result":values})).unwrap();
    let remaining = copied_files::MAX_RESPONSE_BYTES - body(&files).len();
    files
        .last_mut()
        .unwrap()
        .path
        .push_str(&"\u{1}".repeat(remaining / 6));
    files
        .last_mut()
        .unwrap()
        .path
        .push_str(&"x".repeat(remaining % 6));
    assert_eq!(body(&files).len(), copied_files::MAX_RESPONSE_BYTES);
    assert!(copied_files::exact_files(&backend(files.clone())).is_ok());
    files.last_mut().unwrap().path.push('x');
    assert_eq!(body(&files).len(), copied_files::MAX_RESPONSE_BYTES + 1);
    assert!(copied_files::exact_files(&backend(files)).is_err());
}
