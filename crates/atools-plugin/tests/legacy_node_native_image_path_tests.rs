use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::{json, Value};
use std::path::Path;

const LOGO: &[u8] = include_bytes!("../../../ZTools-plugins/plugins/calculation-paper/logo.png");

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

async fn start(temp: &tempfile::TempDir) -> LegacyNodeSession {
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw Error('not executed')",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("fd_probe.cjs"),
        "const fs=require('node:fs'); module.exports={count(){return fs.readdirSync('/dev/fd').length}};",
    )
    .unwrap();
    LegacyNodeSession::start(
        "native-image-source-test",
        temp.path(),
        Path::new("preload.cjs"),
    )
    .await
    .unwrap()
}

async fn descriptor_count(session: &LegacyNodeSession) -> u64 {
    let module = session
        .request("require", json!({"specifier":"./fd_probe.cjs"}))
        .await
        .unwrap();
    let function = session
        .request(
            "get",
            json!({"handleId":module["handleId"],"property":"count"}),
        )
        .await
        .unwrap();
    let value: Value = session
        .request("call", json!({"handleId":function["handleId"],"args":[]}))
        .await
        .unwrap();
    value["value"].as_u64().unwrap()
}

#[tokio::test]
async fn typed_path_method_transports_exact_bytes_without_extending_generic_request() {
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("source.png");
    std::fs::write(&png, LOGO).unwrap();
    let opaque = temp.path().join("deferred-format-validation.bin");
    let opaque_bytes = b"format validation belongs to the host image engine";
    std::fs::write(&opaque, opaque_bytes).unwrap();
    let session = start(&temp).await;
    let before_count = descriptor_count(&session).await;

    let source = session
        .read_native_image_path(png.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(source.bytes.as_slice(), LOGO);
    let opaque_source = session
        .read_native_image_path(opaque.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(opaque_source.bytes.as_slice(), opaque_bytes);
    assert_eq!(descriptor_count(&session).await, before_count);

    let generic = session
        .request("readNativeImagePath", json!({"path":png}))
        .await;
    assert!(
        generic.is_err(),
        "typed path reads must not enter generic request"
    );
    session.stop().await.unwrap();
}

#[tokio::test]
async fn typed_path_method_transports_the_full_four_mib_limit_without_fd_growth() {
    let temp = tempfile::tempdir().unwrap();
    let source_bytes = vec![0xa5u8; 4 * 1024 * 1024];
    let source_path = temp.path().join("four-mib.bin");
    std::fs::write(&source_path, &source_bytes).unwrap();
    let session = start(&temp).await;
    let before_count = descriptor_count(&session).await;

    let source = session
        .read_native_image_path_with_limit(source_path.to_str().unwrap(), 4 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(source.bytes.len(), 4 * 1024 * 1024);
    assert!(source.bytes.as_slice() == source_bytes.as_slice());
    assert_eq!(descriptor_count(&session).await, before_count);

    session.stop().await.unwrap();
}

#[tokio::test]
async fn old_png_path_method_keeps_its_existing_generic_response_shape() {
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("source.png");
    std::fs::write(&png, LOGO).unwrap();
    let session = start(&temp).await;
    let before_count = descriptor_count(&session).await;
    let value = session
        .request("readPngPath", json!({"path":png}))
        .await
        .unwrap();
    assert_eq!(value["kind"], "typedArray");
    assert_eq!(value["name"], "Uint8Array");
    assert_eq!(descriptor_count(&session).await, before_count);
    session.stop().await.unwrap();
}

#[tokio::test]
async fn typed_path_reader_honors_reserved_budget_below_global_maximum() {
    let temp = tempfile::tempdir().unwrap();
    let source_bytes = vec![0x5au8; 512 * 1024];
    let source_path = temp.path().join("reserved-budget.bin");
    std::fs::write(&source_path, &source_bytes).unwrap();
    let session = start(&temp).await;
    let before_count = descriptor_count(&session).await;

    let source = session
        .read_native_image_path_with_limit(source_path.to_str().unwrap(), 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(source.bytes, source_bytes);

    let error = error_text(
        session
            .read_native_image_path_with_limit(source_path.to_str().unwrap(), 256 * 1024)
            .await
            .unwrap_err(),
    );
    assert!(error.contains("Image source exceeds the supported limit"));
    assert!(!error.contains(source_path.to_string_lossy().as_ref()));
    assert!(session
        .read_native_image_path_with_limit(source_path.to_str().unwrap(), 0)
        .await
        .is_err());
    assert!(session
        .read_native_image_path_with_limit(source_path.to_str().unwrap(), 4 * 1024 * 1024 + 1)
        .await
        .is_err());
    assert_eq!(descriptor_count(&session).await, before_count);
    session.stop().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn typed_path_reader_rejects_invalid_files_without_leaking_paths_or_blocking() {
    let temp = tempfile::tempdir().unwrap();
    let session = start(&temp).await;
    let before_count = descriptor_count(&session).await;

    let missing = temp.path().join("private-missing-image.bin");
    let error = error_text(
        session
            .read_native_image_path(missing.to_str().unwrap())
            .await
            .unwrap_err(),
    );
    assert!(error.contains("Image source is unavailable"));
    assert!(!error.contains(missing.to_string_lossy().as_ref()));

    let relative_error = error_text(
        session
            .read_native_image_path("relative.png")
            .await
            .unwrap_err(),
    );
    assert!(relative_error.contains("Invalid local image path"));
    assert!(!relative_error.contains("relative.png"));
    assert!(session.read_native_image_path("bad\0path").await.is_err());
    assert!(session
        .read_native_image_path(&"a".repeat(8193))
        .await
        .is_err());

    let directory_error = error_text(
        session
            .read_native_image_path(temp.path().to_str().unwrap())
            .await
            .unwrap_err(),
    );
    assert!(!directory_error.contains(temp.path().to_string_lossy().as_ref()));

    let empty = temp.path().join("empty.bin");
    std::fs::write(&empty, []).unwrap();
    assert!(session
        .read_native_image_path(empty.to_str().unwrap())
        .await
        .is_err());

    let oversized = temp.path().join("oversized.bin");
    std::fs::write(&oversized, vec![7u8; 4 * 1024 * 1024 + 1]).unwrap();
    let error = error_text(
        session
            .read_native_image_path(oversized.to_str().unwrap())
            .await
            .unwrap_err(),
    );
    assert!(error.contains("Image source exceeds the supported limit"));
    assert!(!error.contains(oversized.to_string_lossy().as_ref()));

    let valid = temp.path().join("valid.bin");
    std::fs::write(&valid, b"bounded regular file").unwrap();
    let symlink = temp.path().join("linked.bin");
    std::os::unix::fs::symlink(&valid, &symlink).unwrap();
    let symlink_error = error_text(
        session
            .read_native_image_path(symlink.to_str().unwrap())
            .await
            .unwrap_err(),
    );
    assert!(!symlink_error.contains(symlink.to_string_lossy().as_ref()));

    use std::ffi::CString;
    let fifo = temp.path().join("no-writer.fifo");
    let c_path = CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();
    let fifo_error = error_text(
        session
            .read_native_image_path(fifo.to_str().unwrap())
            .await
            .unwrap_err(),
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(!fifo_error.contains(fifo.to_string_lossy().as_ref()));
    assert_eq!(descriptor_count(&session).await, before_count);
    session.stop().await.unwrap();
}
