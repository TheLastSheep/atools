use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn tiny_bounded_png() -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13_u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&64_u32.to_be_bytes());
    bytes.extend_from_slice(&64_u32.to_be_bytes());
    bytes
}

#[test]
fn warm_cache_returns_png_without_calling_generator_again() {
    let service = IconService::default();
    let calls = AtomicUsize::new(0);
    let first = service
        .cached_png("member-id", || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some(tiny_bounded_png())
        })
        .unwrap();
    let second = service
        .cached_png("member-id", || {
            calls.fetch_add(1, Ordering::SeqCst);
            Some(tiny_bounded_png())
        })
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let response = png_response(second, Some("http://localhost:1420"));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["cache-control"], PRIVATE_CACHE_CONTROL);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["vary"], "Origin, Referer");
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:1420"
    );
    let no_origin = png_response(Arc::from(tiny_bounded_png()), None);
    assert!(!no_origin
        .headers()
        .contains_key("access-control-allow-origin"));
    assert_eq!(no_origin.headers()["vary"], "Origin, Referer");
}

#[test]
fn generated_bytes_must_stay_inside_png_budget() {
    let service = IconService::default();
    let mut invalid = tiny_bounded_png();
    invalid[16..20].copy_from_slice(&32_u32.to_be_bytes());
    assert_eq!(
        service.cached_png("bad-size", || Some(invalid)),
        Err(IconFailure::Internal)
    );
    assert!(service.cache.lock().entries.is_empty());
}

#[test]
fn pending_admission_is_bounded_to_128_requests() {
    let service = IconService::default();
    let permits = (0..MAX_PENDING_REQUESTS)
        .map(|_| service.try_admit().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        service.try_admit().unwrap_err(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(permits);
    assert!(service.try_admit().is_ok());
}

#[test]
fn cache_enforces_entry_lru_and_five_minute_ttl() {
    let mut cache = IconCache::default();
    let now = Instant::now();
    for index in 0..MAX_CACHE_ENTRIES {
        cache.insert(index.to_string(), Arc::<[u8]>::from(vec![index as u8]), now);
    }
    assert!(cache.get("0", now).is_some());
    cache.insert("newest".into(), Arc::<[u8]>::from(vec![255_u8]), now);
    assert!(cache.get("0", now).is_some());
    assert!(cache.get("1", now).is_none());
    assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);

    assert!(cache
        .get("0", now + CACHE_TTL - Duration::from_nanos(1))
        .is_some());
    assert!(cache.get("0", now + CACHE_TTL).is_none());
    assert_eq!(cache.entries.len(), 0);
    assert_eq!(cache.total_bytes, 0);
}

#[test]
fn cache_enforces_aggregate_byte_budget() {
    let mut cache = IconCache::default();
    let now = Instant::now();
    let bytes: Arc<[u8]> = Arc::from(vec![7_u8; super::super::image::MAX_PNG_BYTES]);
    for index in 0..129 {
        cache.insert(index.to_string(), Arc::clone(&bytes), now);
    }
    assert_eq!(cache.total_bytes, MAX_CACHE_BYTES);
    assert_eq!(cache.entries.len(), MAX_CACHE_BYTES / bytes.len());
    assert!(cache.get("0", now).is_none());
    assert!(cache.get("128", now).is_some());
}

#[tokio::test]
async fn canceled_waiter_keeps_worker_and_pending_permits_until_blocking_work_finishes() {
    let workers = Arc::new(Semaphore::new(1));
    let pending_pool = Arc::new(Semaphore::new(1));
    let pending = Arc::new(pending_pool.clone().try_acquire_owned().unwrap());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn(run_bounded_blocking(
        Arc::clone(&workers),
        Arc::clone(&pending),
        move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        },
    ));
    drop(pending);

    started_rx.await.unwrap();
    assert_eq!(workers.available_permits(), 0);
    assert_eq!(pending_pool.available_permits(), 0);
    task.abort();
    let _ = task.await;
    assert_eq!(workers.available_permits(), 0);
    assert_eq!(pending_pool.available_permits(), 0);

    release_tx.send(()).unwrap();
    let pending =
        tokio::time::timeout(Duration::from_secs(2), pending_pool.clone().acquire_owned())
            .await
            .unwrap()
            .unwrap();
    drop(pending);
    assert_eq!(pending_pool.available_permits(), 1);
    assert_eq!(workers.available_permits(), 1);
}

#[tokio::test]
async fn pending_admission_remains_held_until_response_submission() {
    let workers = Arc::new(Semaphore::new(1));
    let pending_pool = Arc::new(Semaphore::new(1));
    let admission_owner = Arc::new(pending_pool.clone().try_acquire_owned().unwrap());
    let (result_ready_tx, result_ready_rx) = tokio::sync::oneshot::channel();
    let (submit_response_tx, submit_response_rx) = tokio::sync::oneshot::channel();
    let task_workers = Arc::clone(&workers);
    let task = tokio::spawn(async move {
        let result = run_bounded_blocking(task_workers, Arc::clone(&admission_owner), || ()).await;
        assert!(result.is_ok());
        result_ready_tx.send(()).unwrap();

        // This wait models the gap between completed blocking work and
        // `responder.respond`; the async owner keeps total in-flight charged.
        submit_response_rx.await.unwrap();
        drop(admission_owner);
    });

    result_ready_rx.await.unwrap();
    assert_eq!(workers.available_permits(), 1);
    assert_eq!(pending_pool.available_permits(), 0);
    submit_response_tx.send(()).unwrap();
    task.await.unwrap();
    assert_eq!(pending_pool.available_permits(), 1);
}

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
#[test]
fn owned_catalog_member_resolves_to_a_real_bounded_system_icon() {
    use crate::launcher_app_catalog_source::LauncherAppCatalogSource;
    use std::fs;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("launcher-apps");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("Example.app")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let source = LauncherAppCatalogSource::from_owned_fixture_directory(&root).unwrap();
    let other_root = temporary.path().join("other").join("launcher-apps");
    fs::create_dir_all(&other_root).unwrap();
    fs::create_dir(other_root.join("Other.app")).unwrap();
    let other_root = fs::canonicalize(other_root).unwrap();
    let other_source = LauncherAppCatalogSource::from_owned_fixture_directory(&other_root).unwrap();
    let other_app = other_source
        .snapshot()
        .unwrap()
        .into_iter()
        .find(|app| app.path().ends_with("Other.app"))
        .unwrap();
    let app = source
        .snapshot()
        .unwrap()
        .into_iter()
        .find(|app| app.path().ends_with("Example.app"))
        .unwrap();
    let id = icon_id(app.path());
    let service = IconService::default();
    assert_eq!(
        service.resolve_blocking(&source, &icon_id(other_app.path())),
        Err(IconFailure::NotFound)
    );
    let first = service.resolve_blocking(&source, &id).unwrap();
    let second = service.resolve_blocking(&source, &id).unwrap();

    assert!(Arc::ptr_eq(&first, &second));
    assert!(has_bounded_png(&first));
    assert_eq!(service.cache.lock().entries.len(), 1);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_is_explicit() {
    let service = IconService::default();
    assert_eq!(
        service.resolve_blocking(&LauncherAppCatalogSource::default(), "a"),
        Err(IconFailure::Unsupported)
    );
}
