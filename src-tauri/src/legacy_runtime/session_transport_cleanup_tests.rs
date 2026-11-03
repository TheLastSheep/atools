use super::super::session_tests::{assert_listener_closed, listener};
use super::session_opening::OpeningLease;
use super::Sessions;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
use tokio::net::TcpStream;

async fn listener_closes_within(origin: &str, timeout: Duration) -> bool {
    let address = origin.strip_prefix("http://").unwrap();
    tokio::time::timeout(timeout, async {
        loop {
            match TcpStream::connect(address).await {
                Ok(stream) => drop(stream),
                Err(_) => break,
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test(flavor = "current_thread")]
async fn opening_drop_retries_idle_listener_cleanup_after_server_lock_contention() {
    let runtime = Sessions::default();
    let origin = listener(&runtime).await;
    let address = origin.strip_prefix("http://").unwrap();
    let server_guard = runtime.server.lock().await;
    let opening = OpeningLease::begin(
        &runtime,
        "window:main:cleanup-race",
        "fixture-plugin",
        Arc::new(AtomicBool::new(false)),
        None,
    );

    // Drop invokes the production try_lock cleanup while this real server mutex
    // is held, deterministically taking its contention branch.
    drop(opening);
    let openings_empty = runtime.openings.lock().is_empty();
    let listener_stayed_open_while_locked = TcpStream::connect(address).await.is_ok();
    drop(server_guard);

    let idle_cleanup_completed = listener_closes_within(&origin, Duration::from_millis(150)).await;
    runtime.stop_all().await;
    assert_listener_closed(&origin).await;

    assert!(openings_empty, "dropping the lease must remove its opening");
    assert!(
        listener_stayed_open_while_locked,
        "contention must not close the listener before the server lock is released"
    );
    assert!(
        idle_cleanup_completed,
        "dropping the last opening must eventually close its idle transport after lock contention"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn queued_idle_cleanup_keeps_transport_for_a_new_opening() {
    let runtime = Sessions::default();
    let origin = listener(&runtime).await;
    let address = origin.strip_prefix("http://").unwrap();
    let server_guard = runtime.server.lock().await;
    let abandoned = OpeningLease::begin(
        &runtime,
        "window:main:cleanup-old-opening",
        "fixture-plugin",
        Arc::new(AtomicBool::new(false)),
        None,
    );
    drop(abandoned);

    // Register the replacement before the queued cleanup can acquire the real
    // server lock. It must observe this active opening and keep the listener.
    let active = OpeningLease::begin(
        &runtime,
        "window:main:cleanup-new-opening",
        "fixture-plugin",
        Arc::new(AtomicBool::new(false)),
        None,
    );
    drop(server_guard);

    let listener_survived_while_opening = TcpStream::connect(address).await.is_ok();
    let opening_finished = active.finish();
    let idle_cleanup_completed = listener_closes_within(&origin, Duration::from_millis(150)).await;
    runtime.stop_all().await;
    assert_listener_closed(&origin).await;

    assert!(
        listener_survived_while_opening,
        "queued cleanup must not close a transport used by a newly registered opening"
    );
    assert!(
        opening_finished,
        "the replacement opening should finish normally"
    );
    assert!(
        idle_cleanup_completed,
        "finishing the last opening must close its idle transport"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_open_drop_contention_does_not_lose_idle_cleanup() {
    let runtime = Sessions::default();
    let origin = listener(&runtime).await;
    let server_guard = runtime.server.lock().await;

    for index in 0..8 {
        let opening = OpeningLease::begin(
            &runtime,
            &format!("window:main:cleanup-contention-{index}"),
            "fixture-plugin",
            Arc::new(AtomicBool::new(false)),
            None,
        );
        drop(opening);
    }

    drop(server_guard);
    let idle_cleanup_completed = listener_closes_within(&origin, Duration::from_millis(150)).await;
    runtime.stop_all().await;
    assert_listener_closed(&origin).await;

    assert!(
        idle_cleanup_completed,
        "repeated contended open/drop cleanup requests must eventually close the idle listener"
    );
}
