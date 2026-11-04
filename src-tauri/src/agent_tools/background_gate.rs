//! Do not keep a plugin read gate while waiting for its background renderer.
use std::sync::Arc;
use tokio::sync::OwnedRwLockReadGuard;

pub(super) fn executor_guard(
    source: &str,
    pipeline: &mut Option<Arc<OwnedRwLockReadGuard<()>>>,
) -> Option<Arc<OwnedRwLockReadGuard<()>>> {
    if source == crate::plugin_background_runtime::SOURCE {
        drop(pipeline.take());
        None
    } else if source == crate::plugin_file_drag::SOURCE {
        pipeline.take()
    } else {
        pipeline.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::executor_guard;
    use crate::plugin_execution_gates::PluginExecutionGates;
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn background_wait_releases_pipeline_gate_for_writer_then_loader_reader() {
        let gates = Arc::new(PluginExecutionGates::default());
        let plugin = "background-gate-regression";
        let mut pipeline = Some(Arc::new(gates.read(plugin).await));
        let executor = executor_guard(crate::plugin_background_runtime::SOURCE, &mut pipeline);
        assert!(pipeline.is_none());
        assert!(executor.is_none());

        let (receipt_tx, mut receipt_rx) = oneshot::channel::<()>();
        let (writer_entered_tx, writer_entered_rx) = oneshot::channel::<()>();
        let (release_writer_tx, release_writer_rx) = oneshot::channel::<()>();
        let writer_gates = gates.clone();
        let writer = tokio::spawn(async move {
            let _writer = writer_gates.write(plugin).await;
            let _ = writer_entered_tx.send(());
            let _ = release_writer_rx.await;
        });
        tokio::time::timeout(std::time::Duration::from_millis(100), writer_entered_rx)
            .await
            .expect("writer can enter while renderer receipt is pending")
            .unwrap();

        let (loader_read_tx, loader_read_rx) = oneshot::channel::<()>();
        let loader_gates = gates.clone();
        let _loader = tokio::spawn(async move {
            let _loader = loader_gates.read(plugin).await;
            let _ = loader_read_tx.send(());
        });
        tokio::task::yield_now().await;
        let _ = release_writer_tx.send(());
        tokio::time::timeout(std::time::Duration::from_millis(100), loader_read_rx)
            .await
            .expect("loader can acquire the next read permit")
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_millis(100), writer)
            .await
            .expect("writer exits")
            .unwrap();

        assert!(
            receipt_rx.try_recv().is_err(),
            "renderer receipt remains pending"
        );
        drop(receipt_tx);
    }
}
