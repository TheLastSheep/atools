//! Once-only public action; transport loss must be resolved by observation, never replay.
use std::future::Future;

pub(super) async fn run<F, FF, R, RF>(mut fire: F, mut recover: R) -> Result<(), String>
where
    F: FnMut() -> FF,
    FF: Future<Output = Result<(), String>>,
    R: FnMut() -> RF,
    RF: Future<Output = Result<(), String>>,
{
    match fire().await {
        Ok(()) => Ok(()),
        Err(_) => recover().await,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[tokio::test]
    async fn queued_action_drops_ack_then_executes_late_and_is_never_replayed() {
        let queued = Arc::new(AtomicUsize::new(0));
        let observed = queued.clone();
        run(
            || {
                queued.fetch_add(1, Ordering::SeqCst);
                async {
                    // Wry pending_scripts retains the action but drops the callback sender.
                    let (send, receive) = tokio::sync::oneshot::channel::<()>();
                    drop(send);
                    receive
                        .await
                        .map_err(|_| "height Main callback closed".into())
                }
            },
            || {
                let observed = observed.clone();
                async move {
                    assert_eq!(
                        observed.load(Ordering::SeqCst),
                        1,
                        "late queued public action must run only once"
                    );
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn confirmed_ack_does_not_recover_and_unresolved_action_fails() {
        run(
            || async { Ok(()) },
            || async { panic!("must not recover confirmed ack") },
        )
        .await
        .unwrap();
        let error = run(
            || async { Err("closed".into()) },
            || async { Err("actual child absent".into()) },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "actual child absent");
    }
}
