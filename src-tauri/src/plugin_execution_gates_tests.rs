use super::PluginExecutionGates;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

struct NoopWake;

impl Wake for NoopWake {
    fn wake(self: Arc<Self>) {}
}

fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = Waker::from(Arc::new(NoopWake));
    let mut context = Context::from_waker(&waker);
    future.as_mut().poll(&mut context)
}

#[tokio::test]
async fn queued_writer_waits_for_reads_and_blocks_later_readers() {
    let gates = PluginExecutionGates::default();
    let in_flight = gates.read("plugin-a").await;

    let mut writer = Box::pin(gates.write("plugin-a"));
    assert!(poll_once(writer.as_mut()).is_pending());

    let mut later_reader = Box::pin(gates.read("plugin-a"));
    assert!(poll_once(later_reader.as_mut()).is_pending());

    drop(in_flight);
    let exclusive = writer.await;

    let mut newest_reader = Box::pin(gates.read("plugin-a"));
    assert!(poll_once(newest_reader.as_mut()).is_pending());

    drop(exclusive);
    let earlier_reader = later_reader.await;
    drop(earlier_reader);
    drop(newest_reader.await);
}

#[tokio::test]
async fn unrelated_plugin_proceeds_while_writer_is_queued() {
    let gates = PluginExecutionGates::default();
    let in_flight = gates.read("plugin-a").await;

    let mut writer = Box::pin(gates.write("plugin-a"));
    assert!(poll_once(writer.as_mut()).is_pending());

    let unrelated = gates.read("plugin-b").await;
    drop(unrelated);

    drop(in_flight);
    drop(writer.await);
}

#[tokio::test]
async fn canceling_a_queued_writer_releases_its_queue_position() {
    let gates = PluginExecutionGates::default();
    let in_flight = gates.read("plugin-a").await;

    let mut writer = Box::pin(gates.write("plugin-a"));
    assert!(poll_once(writer.as_mut()).is_pending());
    drop(writer);

    let reader_after_cancel = gates.read("plugin-a").await;
    drop(reader_after_cancel);

    drop(in_flight);
    drop(gates.write("plugin-a").await);
}

#[tokio::test]
async fn cleanup_preserves_a_live_lock_and_prunes_unused_registry_entries() {
    let gates = PluginExecutionGates::default();
    let live_reader = gates.read("still-active").await;

    for index in 0..256 {
        drop(gates.read(&format!("finished-{index}")).await);
    }
    assert!(gates.locks.lock().len() > super::WEAK_REGISTRY_CLEANUP_THRESHOLD);

    drop(gates.read("trigger-cleanup").await);
    let locks = gates.locks.lock();
    assert!(locks.len() <= 2);
    assert!(locks
        .get("still-active")
        .and_then(std::sync::Weak::upgrade)
        .is_some());
    drop(locks);

    let mut writer = Box::pin(gates.write("still-active"));
    assert!(poll_once(writer.as_mut()).is_pending());
    drop(live_reader);
    drop(writer.await);
}
