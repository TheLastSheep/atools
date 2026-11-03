//! Service recording on the existing worker while unrelated operations are pending.
use super::recording_gate::{Gate, Notice};
use std::future::{pending, Future};
pub(super) async fn service<T>(
    gate: &Gate,
    future: impl Future<Output = T>,
    mut deliver: impl FnMut(Notice),
) -> T {
    tokio::pin!(future);
    loop {
        let wake = gate.wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        let (deadline, notices) = gate.tick();
        for notice in notices {
            deliver(notice);
        }
        let timer = async {
            if let Some(deadline) = deadline {
                tokio::time::sleep_until(deadline.into()).await;
            } else {
                pending::<()>().await;
            }
        };
        tokio::select! { result=&mut future=>return result, _=&mut wake=>{}, _=timer=>{} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hotkey::recording::Target;
    use std::{sync::Arc, time::Duration};
    #[tokio::test(start_paused = true)]
    async fn delayed_old_work_does_not_block_release_or_deadline() {
        let gate = Arc::new(Gate::default());
        let receipt = gate.receipt(Some("Ctrl+A".into())).unwrap();
        receipt.publish();
        let target = Target {
            session_id: "s".into(),
            label: "child".into(),
            origin: "local".into(),
            bundle_revision: "r".into(),
            visibility_epoch: 1,
        };
        let (notices, mut receive) = tokio::sync::mpsc::channel(3);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let worker = service(&gate, rx, |n| notices.try_send(n.value).unwrap());
        let delay = async {
            tokio::task::yield_now().await; // old work is already waiting
            gate.start(target, 1).unwrap();
            receipt.edge(true);
            receipt.edge(false);
            assert_eq!(receive.recv().await.unwrap()["status"], "recorded");
            receipt.edge(true); // timeout must not clear this held key
            tokio::time::advance(Duration::from_secs(31)).await;
            let stopped = receive.recv().await.unwrap();
            assert_eq!(stopped["reason"], "timeout");
            assert_eq!(stopped["drained"], false);
            receipt.edge(false);
            assert_eq!(receive.recv().await.unwrap()["drained"], true);
            let _ = tx.send(());
        };
        let (result, _) = tokio::join!(worker, delay);
        assert!(result.is_ok());
    }
}
