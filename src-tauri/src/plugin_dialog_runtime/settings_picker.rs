//! Narrow native path selection for the trusted settings child.
use super::{native, options::Options, registry::Access};
use std::{future::Future, sync::Arc};
use tauri::{AppHandle, Manager};
use tokio::task::JoinHandle;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LocalSelectionKind {
    File,
    Folder,
}

pub(crate) fn supported() -> bool {
    native::supported()
}

impl LocalSelectionKind {
    fn property(self) -> &'static str {
        match self {
            Self::File => "openFile",
            Self::Folder => "openDirectory",
        }
    }
}

pub(crate) async fn select_local_shortcut_path<F>(
    app: AppHandle,
    request_id: String,
    kind: LocalSelectionKind,
    session_closing: F,
) -> Result<Option<String>, String>
where
    F: Future<Output = ()> + Send + 'static,
{
    if !native::supported() {
        return Err("ERR_ATOOLS_DIALOG_UNSUPPORTED_PLATFORM: native settings selection is currently available on macOS".into());
    }
    if request_id.is_empty() || request_id.len() > 128 || request_id.contains('\0') {
        return Err("Invalid native settings selection request".into());
    }

    let state = app
        .try_state::<Arc<native::State>>()
        .ok_or("Native panel runtime is unavailable")?
        .inner()
        .clone();
    let cancellation = native::Cancellation::default();
    let close_watch = cancellation_watch(session_closing, cancellation.clone());

    let result = native::show(
        &app,
        "main",
        &request_id,
        Access::Open,
        Options {
            properties: vec![kind.property().into()],
            ..Options::default()
        },
        cancellation,
        None,
        state,
    )
    .await;
    close_watch.abort();

    selection_result(result)
}

fn selection_result(result: Result<Vec<String>, String>) -> Result<Option<String>, String> {
    match result? {
        paths if paths.is_empty() => Ok(None),
        mut paths if paths.len() == 1 => Ok(paths.pop()),
        _ => Err("Native settings selection returned an invalid result".into()),
    }
}

fn cancellation_watch<F>(future: F, cancellation: native::Cancellation) -> JoinHandle<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        future.await;
        cancellation.cancel();
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn selection_kind_maps_to_one_narrow_open_property() {
        assert_eq!(LocalSelectionKind::File.property(), "openFile");
        assert_eq!(LocalSelectionKind::Folder.property(), "openDirectory");
    }

    #[test]
    fn picker_result_preserves_cancel_and_requires_one_selected_path() {
        assert_eq!(selection_result(Ok(Vec::new())).unwrap(), None);
        assert_eq!(
            selection_result(Ok(vec!["/tmp/one".into()])).unwrap(),
            Some("/tmp/one".into())
        );
        assert!(selection_result(Ok(vec!["/tmp/a".into(), "/tmp/b".into()])).is_err());
        assert!(selection_result(Err("private native failure".into())).is_err());
    }

    #[tokio::test]
    async fn session_close_is_forwarded_to_the_native_panel_cancellation() {
        let cancellation = native::Cancellation::default();
        let observed = cancellation.clone();
        let (close, closed) = tokio::sync::oneshot::channel::<()>();
        let watcher = cancellation_watch(
            async move {
                let _ = closed.await;
            },
            cancellation,
        );
        let _ = close.send(());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !observed.cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("session close should cancel the native panel");
        watcher.await.unwrap();
    }
}
