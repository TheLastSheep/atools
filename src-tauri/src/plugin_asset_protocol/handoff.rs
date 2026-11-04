//! Final resource response and the guards that own its bounded lifetime.
use super::{
    leases::{Lease, Resources},
    request,
};
use crate::plugin_window_sources::{RendererPermit, WindowDocument};
use std::sync::Arc;
use tauri::http::{Response, StatusCode};

pub(super) type MainThreadJob = Box<dyn FnOnce() + Send + 'static>;

pub(super) fn enqueue<G: Send + 'static, E>(
    guards: G,
    schedule: impl FnOnce(MainThreadJob) -> Result<(), E>,
    action: impl FnOnce() + Send + 'static,
) -> Result<(), E> {
    schedule(Box::new(move || {
        let _guards = guards;
        action();
    }))
}

#[cfg(test)]
pub(super) fn dispatch<G: Send + 'static, E>(
    resources: Arc<Resources>,
    lease: Lease,
    response: Response<Vec<u8>>,
    head: bool,
    guards: G,
    schedule: impl FnOnce(MainThreadJob) -> Result<(), E>,
    respond: impl FnOnce(Response<Vec<u8>>) + Send + 'static,
) -> Result<(), E> {
    dispatch_with_renderer(
        resources, lease, response, head, guards, None, schedule, respond,
    )
}

pub(super) fn dispatch_with_renderer<G: Send + 'static, E>(
    resources: Arc<Resources>,
    lease: Lease,
    response: Response<Vec<u8>>,
    head: bool,
    guards: G,
    renderer: Option<RendererPermit>,
    schedule: impl FnOnce(MainThreadJob) -> Result<(), E>,
    respond: impl FnOnce(Response<Vec<u8>>) + Send + 'static,
) -> Result<(), E> {
    // Enqueue before taking store: WebKit's responder can wait for the main
    // runloop on a worker. The final check and response stay atomic on main.
    enqueue(guards, schedule, move || {
        let mut response = Some(response);
        let mut respond = Some(respond);
        let delivered = resources
            .if_current(&lease, || match renderer.as_ref() {
                Some(renderer) => renderer
                    .if_active(|| respond.take().unwrap()(response.take().unwrap()))
                    .is_some(),
                None => {
                    respond.take().unwrap()(response.take().unwrap());
                    true
                }
            })
            .unwrap_or(false);
        if !delivered {
            respond.take().unwrap()(request::error(StatusCode::NOT_FOUND, head));
        }
    })
}

pub(super) fn dispatch_window_document<G: Send + 'static, E>(
    resources: Arc<Resources>,
    lease: Lease,
    document: Arc<WindowDocument>,
    mime: &'static str,
    head: bool,
    options: bool,
    guards: G,
    renderer: RendererPermit,
    schedule: impl FnOnce(MainThreadJob) -> Result<(), E>,
    respond: impl FnOnce(Response<Vec<u8>>) + Send + 'static,
) -> Result<(), E> {
    enqueue(guards, schedule, move || {
        let mut respond = Some(respond);
        let delivered = resources
            .if_current(&lease, || {
                renderer.if_active(|| {
                    let (status, bytes) = if options {
                        (StatusCode::NO_CONTENT, &[][..])
                    } else {
                        (StatusCode::OK, document.body.as_bytes())
                    };
                    respond.take().unwrap()(request::response_slice(status, mime, bytes, head));
                })
            })
            .is_some_and(|active| active.is_some());
        if !delivered {
            respond.take().unwrap()(request::error(StatusCode::NOT_FOUND, head));
        }
    })
}
