use std::{future::Future, time::Duration};
use tokio::sync::oneshot;

pub(super) struct CancelOnDrop<F: FnOnce(u64)> {
    probe_id: u64,
    cancel: Option<F>,
}

impl<F: FnOnce(u64)> CancelOnDrop<F> {
    pub(super) fn new(probe_id: u64, cancel: F) -> Self {
        Self {
            probe_id,
            cancel: Some(cancel),
        }
    }
}

impl<F: FnOnce(u64)> Drop for CancelOnDrop<F> {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel(self.probe_id);
        }
    }
}

pub(super) fn await_probe<T, F>(
    probe_id: u64,
    receiver: oneshot::Receiver<Result<T, &'static str>>,
    timeout: Duration,
    cancel: F,
) -> impl Future<Output = Result<T, &'static str>> + Send
where
    T: Send,
    F: FnOnce(u64) + Send,
{
    let cancel_on_drop = CancelOnDrop::new(probe_id, cancel);
    async move {
        let result = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("settings-input-probe-protocol-rejected"),
            Err(_) => Err("settings-input-probe-timeout"),
        };
        drop(cancel_on_drop);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::await_probe;
    use crate::renderer_desktop_smoke::settings_input_journey::probe_protocol::{
        BeginError, PendingProbes, ProbeReply,
    };
    use std::{
        future::{poll_fn, Future},
        sync::{Arc, Mutex},
        task::Poll,
        time::Duration,
    };
    use tokio::sync::oneshot;

    type Pending = Arc<Mutex<PendingProbes<oneshot::Sender<Result<(), &'static str>>>>>;

    fn begin(pending: &Pending) -> (u64, oneshot::Receiver<Result<(), &'static str>>) {
        let (sender, receiver) = oneshot::channel();
        let id = pending
            .lock()
            .unwrap()
            .begin("token", "mainInspect", "main", sender)
            .unwrap();
        (id, receiver)
    }

    fn cancel_with(pending: &Pending) -> impl FnOnce(u64) + Send + 'static {
        let pending = Arc::clone(pending);
        move |id| {
            let _ = pending.lock().unwrap().cancel(id);
        }
    }

    fn assert_next_probe_can_begin(pending: &Pending, previous_id: u64) {
        {
            let pending = pending.lock().unwrap();
            assert!(!pending.is_pending());
        }
        let (next_id, _next_receiver) = begin(pending);
        assert_eq!(next_id, previous_id + 1);
    }

    #[test]
    fn dropping_an_unpolled_probe_future_releases_the_slot() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (id, receiver) = begin(&pending);
        let waiter = await_probe(id, receiver, Duration::from_secs(30), cancel_with(&pending));
        drop(waiter);

        assert_next_probe_can_begin(&pending, id);
    }

    #[tokio::test]
    async fn dropping_an_awaiting_probe_releases_the_slot_and_allows_the_next_probe() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (id, receiver) = begin(&pending);
        let mut waiter = Box::pin(await_probe(
            id,
            receiver,
            Duration::from_secs(30),
            cancel_with(&pending),
        ));
        poll_fn(|cx| match waiter.as_mut().poll(cx) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(_) => panic!("probe waiter unexpectedly completed"),
        })
        .await;
        drop(waiter);

        assert_next_probe_can_begin(&pending, id);
    }

    #[tokio::test]
    async fn an_outer_timeout_drops_the_probe_guard_and_releases_the_slot() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (id, receiver) = begin(&pending);
        let result = tokio::time::timeout(
            Duration::from_millis(2),
            await_probe(id, receiver, Duration::from_secs(30), cancel_with(&pending)),
        )
        .await;
        assert!(result.is_err());

        assert_next_probe_can_begin(&pending, id);
    }

    #[tokio::test]
    async fn aborting_a_waiting_probe_releases_the_slot() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (id, receiver) = begin(&pending);
        let abort_pending = Arc::clone(&pending);
        let (waiting_tx, waiting_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut waiter = Box::pin(await_probe(
                id,
                receiver,
                Duration::from_secs(30),
                cancel_with(&abort_pending),
            ));
            poll_fn(|cx| match waiter.as_mut().poll(cx) {
                Poll::Pending => Poll::Ready(()),
                Poll::Ready(_) => panic!("probe waiter unexpectedly completed"),
            })
            .await;
            let _ = waiting_tx.send(());
            waiter.await
        });
        let _ = waiting_rx.await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());

        assert_next_probe_can_begin(&pending, id);
    }

    #[tokio::test]
    async fn a_successfully_completed_old_guard_cannot_cancel_a_new_probe() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (old_id, old_receiver) = begin(&pending);
        let old_sender =
            match pending
                .lock()
                .unwrap()
                .take_reply("token", old_id, "mainInspect", "main")
            {
                ProbeReply::Matched(sender) => sender,
                _ => panic!("old probe did not match"),
            };
        let (new_id, new_receiver) = begin(&pending);
        let result = await_probe(
            old_id,
            old_receiver,
            Duration::from_secs(30),
            cancel_with(&pending),
        );
        old_sender.send(Ok(())).unwrap();
        assert_eq!(result.await, Ok(()));
        assert!(pending.lock().unwrap().is_pending());
        assert!(pending.lock().unwrap().cancel(old_id).is_none());
        assert!(pending.lock().unwrap().is_pending());
        drop(pending.lock().unwrap().cancel(new_id));
        assert!(new_receiver.await.is_err());
    }

    #[test]
    fn cancellation_during_finished_or_wrong_id_state_does_not_clear_a_slot() {
        let pending = Arc::new(Mutex::new(PendingProbes::default()));
        let (id, _receiver) = begin(&pending);
        let mut pending = pending.lock().unwrap();
        assert!(pending.cancel(id + 1).is_none());
        assert!(pending.is_pending());
        assert!(pending.finish().is_some());
        assert!(pending.cancel(id).is_none());
        let (late_sender, late_receiver) = oneshot::channel();
        assert_eq!(
            pending.begin("token", "mainInspect", "main", late_sender),
            Err(BeginError::Finished)
        );
        drop(late_receiver);
    }
}
