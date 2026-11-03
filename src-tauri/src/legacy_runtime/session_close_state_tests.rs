use super::remove_after_stop;
use super::{close_ids_in_order, StopCompletion};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;

#[tokio::test]
async fn concurrent_close_waiters_share_a_failed_stop_result() {
    let completion = Arc::new(StopCompletion::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());

    let first_completion = Arc::clone(&completion);
    let first_calls = Arc::clone(&calls);
    let first_entered = Arc::clone(&entered);
    let first_release = Arc::clone(&release);
    let first = tokio::spawn(async move {
        first_completion
            .run_once(|| async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                first_entered.notify_one();
                first_release.notified().await;
                Err("auxiliary process was not reaped".into())
            })
            .await
    });

    tokio::time::timeout(Duration::from_secs(1), entered.notified())
        .await
        .expect("first shutdown enters the controlled stop point");

    let second_completion = Arc::clone(&completion);
    let second_calls = Arc::clone(&calls);
    let second = tokio::spawn(async move {
        second_completion
            .run_once(|| async move {
                second_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
    });

    release.notify_one();
    let first_result = first.await.unwrap();
    let second_result = second.await.unwrap();
    assert_eq!(first_result, Err("auxiliary process was not reaped".into()));
    assert_eq!(second_result, first_result);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn session_stays_registered_until_stop_finishes_and_remains_on_failure() {
    let sessions = Arc::new(RwLock::new(HashMap::from([(
        "session".to_owned(),
        Arc::new("owner".to_owned()),
    )])));
    let session = sessions.read().get("session").unwrap().clone();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());

    let close_sessions = Arc::clone(&sessions);
    let close_session = Arc::clone(&session);
    let close_entered = Arc::clone(&entered);
    let close_release = Arc::clone(&release);
    let close = tokio::spawn(async move {
        remove_after_stop(&close_sessions, "session", &close_session, || async move {
            close_entered.notify_one();
            close_release.notified().await;
            Err("auxiliary process was not reaped".into())
        })
        .await
    });

    tokio::time::timeout(Duration::from_secs(1), entered.notified())
        .await
        .expect("strict close reaches sidecar shutdown");
    assert!(sessions.read().contains_key("session"));
    release.notify_one();

    assert_eq!(
        close.await.unwrap(),
        Err("auxiliary process was not reaped".into())
    );
    assert!(
        sessions.read().contains_key("session"),
        "failed stop must remain tracked"
    );
}

#[tokio::test]
async fn successful_stop_removes_the_exact_registered_session() {
    let sessions = RwLock::new(HashMap::new());
    let session = Arc::new("owner".to_owned());
    sessions
        .write()
        .insert("session".to_owned(), Arc::clone(&session));
    let stopped = Arc::new(AtomicUsize::new(0));
    let stopped_on_close = Arc::clone(&stopped);

    remove_after_stop(&sessions, "session", &session, || async move {
        stopped_on_close.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .await
    .unwrap();

    assert_eq!(stopped.load(Ordering::SeqCst), 1);
    assert!(!sessions.read().contains_key("session"));
}

#[tokio::test]
async fn owner_close_waits_in_order_and_continues_after_first_stop_error() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let first_entered = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());

    let close_order = Arc::clone(&order);
    let entered = Arc::clone(&first_entered);
    let release = Arc::clone(&release_first);
    let close = tokio::spawn(async move {
        close_ids_in_order(
            vec!["first".to_owned(), "second".to_owned(), "third".to_owned()],
            move |id| {
                let order = Arc::clone(&close_order);
                let entered = Arc::clone(&entered);
                let release = Arc::clone(&release);
                async move {
                    order.lock().push(format!("{id}:start"));
                    if id == "first" {
                        entered.notify_one();
                        release.notified().await;
                        order.lock().push("first:done".into());
                        Err("first shutdown failed".into())
                    } else {
                        order.lock().push(format!("{id}:done"));
                        Ok(())
                    }
                }
            },
        )
        .await
    });

    tokio::time::timeout(Duration::from_secs(1), first_entered.notified())
        .await
        .expect("first owned session begins shutdown");
    assert_eq!(*order.lock(), vec!["first:start"]);
    release_first.notify_one();

    assert_eq!(
        close.await.unwrap(),
        Err("first shutdown failed".into()),
        "the close reports the first stop failure after attempting all sessions"
    );
    assert_eq!(
        *order.lock(),
        vec![
            "first:start",
            "first:done",
            "second:start",
            "second:done",
            "third:start",
            "third:done"
        ]
    );
}
