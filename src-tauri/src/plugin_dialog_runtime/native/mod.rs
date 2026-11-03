//! Native panels own their cancellation. Dropping a waiter also cancels its panel.
use super::{
    observations::{note, Event},
    options::Options,
    registry::Access,
};
use parking_lot::Mutex;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
mod macos;

pub(super) const DEADLINE: Duration = Duration::from_secs(120);
#[derive(Clone)]
pub(super) struct Cancellation(tokio::sync::watch::Sender<bool>);
impl Default for Cancellation {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}
impl Cancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn cancelled(&self) -> bool {
        *self.0.borrow()
    }
    async fn wait(&self) {
        let mut receiver = self.0.subscribe();
        if !*receiver.borrow_and_update() {
            let _ = receiver.changed().await;
        }
    }
}
#[derive(Default)]
pub(super) struct State {
    windows: Mutex<HashSet<String>>,
}
impl State {
    pub fn reserve(self: &Arc<Self>, window: &str) -> Result<Lease, String> {
        let mut windows = self.windows.lock();
        if windows.len() >= 4 || !windows.insert(window.into()) {
            return Err("A native dialog is already active or the dialog limit was reached".into());
        }
        Ok(Lease {
            state: self.clone(),
            window: window.into(),
        })
    }
    pub fn active(&self, window: &str) -> bool {
        self.windows.lock().contains(window)
    }
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn count(&self) -> usize {
        self.windows.lock().len()
    }
}
pub(super) struct Lease {
    state: Arc<State>,
    window: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.state.windows.lock().remove(&self.window);
    }
}
pub(super) fn supported() -> bool {
    cfg!(target_os = "macos")
}

pub(super) async fn show(
    app: &AppHandle,
    window: &str,
    id: &str,
    access: Access,
    options: Options,
    cancellation: Cancellation,
    document: Option<crate::plugin_page_runtime::DocumentBinding>,
    state: Arc<State>,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if cancellation.cancelled() || document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Dialog session closed".into());
        }
        note(Event::NativeAwait);
        let receiver = macos::begin(
            app,
            window,
            id,
            access,
            options,
            cancellation.clone(),
            document,
            state,
        )?;
        let mut guard = Pending {
            app: app.clone(),
            id: id.into(),
            completed: false,
        };
        let result =
            await_completion(receiver, cancellation, DEADLINE, || macos::cancel(app, id)).await;
        guard.completed = true;
        note(match &result {
            Ok(paths) if paths.is_empty() => Event::NativeResultCancelled,
            Ok(_) => Event::NativeResultSelected,
            Err(_) => Event::NativeResultError,
        });
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            window,
            id,
            access,
            options,
            cancellation,
            document,
            state,
        );
        Err("ERR_ATOOLS_DIALOG_UNSUPPORTED_PLATFORM: cancellable native dialogs are currently available on macOS".into())
    }
}
/// Cancellation completion is an explicit native acknowledgement, never a dropped future.
#[cfg(any(target_os = "macos", test))]
async fn await_completion<F: std::future::Future<Output = Result<(), String>>>(
    mut receiver: tokio::sync::oneshot::Receiver<Result<Vec<String>, String>>,
    cancellation: Cancellation,
    deadline: Duration,
    mut cancel: impl FnMut() -> F,
) -> Result<Vec<String>, String> {
    tokio::select! {
        result = &mut receiver => result.map_err(|_| "Native dialog completion was interrupted".to_string())?,
        _ = cancellation.wait() => {
            note(Event::CancelSignal);
            cancel().await?;
            receiver.await.map_err(|_| "Native dialog cancellation was interrupted".to_string())?
        },
        _ = tokio::time::sleep(deadline) => {
            note(Event::Deadline);
            cancel().await?;
            let _ = receiver.await;
            Err("ERR_ATOOLS_DIALOG_TIMEOUT: native dialog timed out and was closed".into())
        }
    }
}
#[cfg(target_os = "macos")]
struct Pending {
    app: AppHandle,
    id: String,
    completed: bool,
}
#[cfg(target_os = "macos")]
impl Drop for Pending {
    fn drop(&mut self) {
        if !self.completed {
            note(Event::PendingDrop);
            macos::cancel_detached(&self.app, &self.id);
        }
    }
}
pub(super) async fn cancel_ids(app: &AppHandle, ids: Vec<String>) {
    #[cfg(target_os = "macos")]
    for id in ids {
        let _ = macos::cancel(app, &id).await;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, ids);
}
pub(super) fn cancel_on_shutdown(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::cancel_all(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn dropping_modal_lease_releases_its_window_and_global_capacity() {
        let state = Arc::new(State::default());
        let first = state.reserve("fixture").unwrap();
        assert!(state.active("fixture"));
        assert_eq!(state.count(), 1);
        assert!(state.reserve("fixture").is_err());
        drop(first);
        assert!(!state.active("fixture"));
        assert_eq!(state.count(), 0);
        let again = state.reserve("fixture").unwrap();
        drop(again);
        assert_eq!(state.count(), 0);
    }
    #[tokio::test]
    async fn deadline_waits_for_native_cancel_acknowledgement_instead_of_dropping_panel() {
        for cancelled in [false, true] {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let closed = Arc::new(AtomicBool::new(false));
            let cancellation = Cancellation::default();
            if cancelled {
                cancellation.cancel();
            }
            let result = await_completion(receiver, cancellation, Duration::from_millis(5), || {
                let sender = sender.clone();
                let closed = closed.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    closed.store(true, Ordering::Release);
                    let _ = sender
                        .lock()
                        .take()
                        .unwrap()
                        .send(Err("closed by native adapter".into()));
                    Ok(())
                }
            })
            .await;
            assert!(closed.load(Ordering::Acquire));
            assert!(sender.lock().is_none());
            let error = result.unwrap_err();
            assert!(error.contains(if cancelled {
                "closed by native"
            } else {
                "TIMEOUT"
            }));
        }
    }
    #[tokio::test]
    async fn successful_selection_does_not_cancel_or_replay_the_native_operation() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(Ok(vec!["/fixture".into()])).unwrap();
        let result = await_completion(
            receiver,
            Cancellation::default(),
            Duration::from_secs(1),
            || async { panic!("unexpected cancellation") },
        )
        .await
        .unwrap();
        assert_eq!(result, vec!["/fixture"]);
    }
}
