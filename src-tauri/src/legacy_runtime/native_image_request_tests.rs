use super::*;
use atools_core::agent::PermissionScope;
use image::ImageEncoder;
use serde_json::json;
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;

fn tool(source: &str, plugin: &str, name: &str, scopes: Vec<PermissionScope>) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "fixture".into(),
        input_schema: json!({}),
        output_schema: None,
        scopes,
        enabled_by_default: true,
        enabled: true,
        source: source.into(),
        plugin_id: Some(plugin.into()),
    }
}

fn tiny_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&[10, 20, 30, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

// For detached blocking work, the join output is dropped only after the closure returns.
// This receipt proves wrapper-owned leases are gone; it does not claim the OS thread exited.
#[derive(Debug)]
struct WorkerCompletion(mpsc::Sender<()>);

impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[test]
fn wire_schema_rejects_unknown_fields_and_null_optional_values() {
    let request = |params| json!({"method":"nativeImageTransform","params":params});
    assert!(parse_request_operation(&request(json!({
        "operation":"encode","handleId":"h","resizePlan":[],"format":"png"
    })))
    .is_ok());
    assert!(parse_request_operation(&request(json!({
        "operation":"openPath","path":"x","other":1
    })))
    .is_err());
    assert!(parse_request_operation(&request(json!({
        "operation":"openBuffer","byteLength":1,"dataBase64":"AA==","other":1
    })))
    .is_err());
    for invalid_envelope in [
        json!({"method":"nativeImageTransform","params":{"operation":"encode","handleId":"h","resizePlan":[],"format":"png"},"id":7}),
        json!({"method":"notNativeImageTransform","params":{"operation":"encode","handleId":"h","resizePlan":[],"format":"png"}}),
        json!({"params":{"operation":"encode","handleId":"h","resizePlan":[],"format":"png"}}),
    ] {
        assert!(parse_request_operation(&invalid_envelope).is_err());
    }
    for invalid in [
        // Even PNG rejects a present jpegQuality:null; it is not equivalent to omission.
        json!({"operation":"encode","handleId":"h","resizePlan":[],"format":"png","jpegQuality":null}),
        json!({"operation":"encode","handleId":"h","resizePlan":[{"width":null}],"format":"png"}),
        json!({"operation":"encode","handleId":"h","resizePlan":[{"height":null}],"format":"png"}),
        json!({"operation":"encode","handleId":"h","resizePlan":[{"height":1,"quality":null}],"format":"png"}),
    ] {
        assert!(parse_request_operation(&request(invalid)).is_err());
    }
    // Omitted optionals retain their contract meaning.
    assert!(parse_request_operation(&request(json!({
        "operation":"encode","handleId":"h","resizePlan":[{"width":1}],"format":"png"
    })))
    .is_ok());
}

#[test]
fn file_path_reads_require_the_exact_registered_legacy_node_tool_and_file_read_scope() {
    let canonical_name = crate::legacy_runtime::registry::tool_name("fixture-plugin");
    let valid = tool(
        "legacy_node",
        "fixture-plugin",
        &canonical_name,
        vec![PermissionScope::FileRead],
    );
    assert!(is_file_read_tool(&valid, "fixture-plugin", &canonical_name));
    assert!(!is_file_read_tool(&valid, "other-plugin", &canonical_name));
    let text_only = tool(
        "legacy_node",
        "fixture-plugin",
        &canonical_name,
        vec![PermissionScope::ClipboardRead],
    );
    assert!(!is_file_read_tool(
        &text_only,
        "fixture-plugin",
        &canonical_name
    ));
    let forged_source = tool(
        "other",
        "fixture-plugin",
        &canonical_name,
        vec![PermissionScope::FileRead],
    );
    assert!(!is_file_read_tool(
        &forged_source,
        "fixture-plugin",
        &canonical_name
    ));
}

#[test]
fn canonical_base64_and_exact_declared_length_are_required() {
    assert_eq!(decode_canonical("AQI=", 2).unwrap(), [1, 2]);
    assert!(decode_canonical("AQI", 2).is_err());
    assert!(decode_canonical("AQJ=", 2).is_err());
    assert!(decode_canonical("AQI=", 1).is_err());
    assert_eq!(encoded_length(1), Some(4));
    assert_eq!(encoded_length(2), Some(4));
    assert_eq!(encoded_length(3), Some(4));
}

#[tokio::test]
async fn path_reader_is_invoked_only_after_the_exact_open_reservation_exists() {
    let engine = NativeImageEngine::new();
    let store = Arc::new(engine.new_session());
    let seen_limit = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = Arc::clone(&seen_limit);
    let store_for_reader = Arc::clone(&store);
    let engine_for_reader = &engine;
    let (reservation, source) = reserve_path_source(&engine, &store, move |limit| async move {
        let second_reservation = engine_for_reader
            .reserve_open(&store_for_reader, OpenSourceKind::NodePath)
            .expect("reader runs while the first reservation is active");
        assert_eq!(second_reservation.max_bytes(), limit);
        assert!(matches!(
            engine_for_reader.reserve_open(&store_for_reader, OpenSourceKind::NodePath),
            Err(NativeImageError::OpenBusy)
        ));
        drop(second_reservation);
        seen.store(limit, std::sync::atomic::Ordering::Release);
        Ok(NativeImageSource {
            bytes: vec![1, 2, 3],
        })
    })
    .await
    .unwrap();
    assert_eq!(
        seen_limit.load(std::sync::atomic::Ordering::Acquire),
        reservation.max_bytes()
    );
    assert_eq!(source.bytes, [1, 2, 3]);
}

#[test]
fn native_image_method_uses_the_existing_taskrun_path_not_poll_fast_path() {
    assert!(super::super::uses_task_run("nativeImageTransform"));
    assert!(!super::super::uses_task_run("poll"));
    assert!(!super::super::uses_task_run("pollPromise"));
    assert!(!super::super::uses_task_run("pollPromises"));
    assert!(!super::super::uses_task_run("release"));
}

#[test]
fn closed_node_image_slot_cannot_be_recreated_by_a_late_open_timeout() {
    let engine = NativeImageEngine::new();
    let slot = ImageSessionStore::default();
    let old = slot.get_or_create(&engine).unwrap();
    slot.close();
    assert!(!slot.retire_timed_out_open(&old, &engine, true));
    assert!(matches!(
        slot.get_or_create(&engine),
        Err(NativeImageError::SessionClosed)
    ));
}

#[test]
fn concurrent_timeout_rotation_and_node_close_leave_the_slot_closed() {
    let engine = Arc::new(NativeImageEngine::new());
    let slot = Arc::new(ImageSessionStore::default());
    let old = slot.get_or_create(&engine).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let timeout_slot = Arc::clone(&slot);
    let timeout_engine = Arc::clone(&engine);
    let timeout_old = Arc::clone(&old);
    let timeout_barrier = Arc::clone(&barrier);
    let timeout = thread::spawn(move || {
        timeout_barrier.wait();
        timeout_slot.retire_timed_out_open(&timeout_old, &timeout_engine, true)
    });
    let close_slot = Arc::clone(&slot);
    let close_barrier = Arc::clone(&barrier);
    let close = thread::spawn(move || {
        close_barrier.wait();
        close_slot.close();
    });
    barrier.wait();
    let _ = timeout.join().unwrap();
    close.join().unwrap();
    assert!(matches!(
        slot.current(),
        Err(NativeImageError::SessionClosed)
    ));
    assert!(matches!(
        slot.get_or_create(&engine),
        Err(NativeImageError::SessionClosed)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_timeout_after_commit_retires_handles_and_concurrent_close_cannot_resurrect_them() {
    let engine = Arc::new(NativeImageEngine::new());
    let slot = ImageSessionStore::default();
    let old = slot.get_or_create(&engine).unwrap();
    let bytes = tiny_png();
    let reservation = engine
        .reserve_open(
            &old,
            OpenSourceKind::WebViewBuffer {
                byte_length: bytes.len(),
            },
        )
        .unwrap();
    let permit = engine.try_worker().unwrap();
    let operation_engine = Arc::clone(&engine);
    let operation_store = Arc::clone(&old);
    let (committed_tx, committed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let operation = move |(token, permit)| {
        let descriptor =
            operation_engine.open_bytes(&operation_store, reservation, bytes, permit, &token)?;
        committed_tx.send(descriptor.handle_id.clone()).unwrap();
        release_rx.recv().unwrap();
        let _ = descriptor;
        Ok(WorkerCompletion(worker_exit_tx))
    };
    let timeout_future = run_open_worker(
        &slot,
        &old,
        &engine,
        || true,
        permit,
        operation,
        Duration::from_millis(25),
    );
    tokio::pin!(timeout_future);
    let handle_id = tokio::select! {
        handle = tokio::task::spawn_blocking(move || committed_rx.recv().unwrap()) => handle.unwrap(),
        result = &mut timeout_future => panic!("worker timed out before commit: {result:?}"),
    };
    let timed_out = timeout_future.await;
    assert!(matches!(timed_out, Err(WorkerFailure::OpenTimedOut)));
    let message = worker_error(WorkerFailure::OpenTimedOut);
    assert!(message.contains("previous image handles were invalidated"));
    assert!(message.contains("reopen explicitly"));
    let replacement = slot.current().unwrap();
    assert!(!Arc::ptr_eq(&replacement, &old));
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));

    // Model Node/document close while the timed-out worker still owns its old lease.
    slot.close();
    release_tx.send(()).unwrap();
    worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let encode = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![],
    };
    assert!(matches!(
        engine.encode(
            &old,
            &handle_id,
            &encode,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default()
        ),
        Err(NativeImageError::SessionClosed)
    ));
    assert!(matches!(
        slot.get_or_create(&engine),
        Err(NativeImageError::SessionClosed)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_open_waiter_cancels_and_retires_before_blocking_worker_exits() {
    let engine = Arc::new(NativeImageEngine::new());
    let slot = Arc::new(ImageSessionStore::default());
    let old = slot.get_or_create(&engine).unwrap();
    let bytes = tiny_png();
    let reservation = engine
        .reserve_open(
            &old,
            OpenSourceKind::WebViewBuffer {
                byte_length: bytes.len(),
            },
        )
        .unwrap();
    let permit = engine.try_worker().unwrap();
    let operation_engine = Arc::clone(&engine);
    let operation_store = Arc::clone(&old);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (opened_tx, opened_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let slot_for_waiter = Arc::clone(&slot);
    let engine_for_waiter = Arc::clone(&engine);
    let store_for_waiter = Arc::clone(&old);
    let waiter = tokio::spawn(async move {
        run_open_worker(
            &slot_for_waiter,
            &store_for_waiter,
            &engine_for_waiter,
            || true,
            permit,
            move |(token, permit)| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let result = operation_engine.open_bytes(
                    &operation_store,
                    reservation,
                    bytes,
                    permit,
                    &token,
                );
                opened_tx.send(result.is_ok()).unwrap();
                let _ = result;
                Ok(WorkerCompletion(worker_exit_tx))
            },
            Duration::from_secs(30),
        )
        .await
    });

    tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
        .await
        .unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    let replacement = slot.current().unwrap();
    assert!(!Arc::ptr_eq(&replacement, &old));
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));

    release_tx.send(()).unwrap();
    assert!(!opened_rx.recv_timeout(Duration::from_secs(1)).unwrap());
    worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(engine.try_worker().is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_encode_waiter_cancels_worker_without_rotating_store() {
    let engine = Arc::new(NativeImageEngine::new());
    let slot = ImageSessionStore::default();
    let store = Arc::new(slot.get_or_create(&engine).unwrap());
    let bytes = tiny_png();
    let reservation = engine
        .reserve_open(
            &store,
            OpenSourceKind::WebViewBuffer {
                byte_length: bytes.len(),
            },
        )
        .unwrap();
    let descriptor = engine
        .open_bytes(
            &store,
            reservation,
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();

    let permit = engine.try_worker().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (cancelled_tx, cancelled_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let waiter = tokio::spawn(run_worker(
        permit,
        move |token, _permit| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            cancelled_tx.send(token.is_cancelled()).unwrap();
            Ok(WorkerCompletion(worker_exit_tx))
        },
        Duration::from_secs(30),
        NativeImageCancellation::default(),
    ));
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
        .await
        .unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert!(slot.is_current(&store));
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));

    release_tx.send(()).unwrap();
    assert!(cancelled_rx.recv_timeout(Duration::from_secs(1)).unwrap());
    worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(engine.try_worker().is_ok());
    assert!(engine
        .encode(
            &store,
            &descriptor.handle_id,
            &EncodeRequest {
                format: OutputFormat::Png,
                jpeg_quality: None,
                resize_plan: vec![],
            },
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_permit_remains_occupied_until_the_blocking_closure_exits() {
    let engine = NativeImageEngine::new();
    let permit = engine.try_worker().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let blocking = run_worker(
        permit,
        move |_token, _permit| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(WorkerCompletion(worker_exit_tx))
        },
        Duration::from_millis(25),
        NativeImageCancellation::default(),
    );
    tokio::pin!(blocking);
    tokio::select! {
        _ = tokio::task::spawn_blocking(move || started_rx.recv().unwrap()) => {}
        result = &mut blocking => panic!("worker returned before entering closure: {result:?}"),
    }
    let timed_out = blocking.await;
    assert!(matches!(timed_out, Err(WorkerFailure::TimedOut)));
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));
    release_tx.send(()).unwrap();
    worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(engine.try_worker().is_ok());
}
