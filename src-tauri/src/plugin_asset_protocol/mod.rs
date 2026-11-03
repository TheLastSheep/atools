//! Window-owned, revocable local resource URLs for opaque plugin iframes.
//! Tokens live in memory only. No TCP listener, Node session or idle task exists.
mod handoff;
mod leases;
mod page_assets;
mod request;

use crate::state::AppState;
use atools_core::Database;
pub(crate) use leases::PreparedResources;
pub(crate) use leases::{authorization, Authorization, Owner};
pub(crate) use leases::{Lease, Resources};
pub(crate) use page_assets::{parse_page_asset, read_page_asset, reserve_page_asset};
#[cfg(feature = "legacy-node-smoke")]
use std::path::Path;
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, WebviewWindow};

const MAX_RESOURCE_BYTES: usize = 8 * 1024 * 1024;

fn resources(app: &AppHandle) -> Arc<Resources> {
    if app.try_state::<Arc<Resources>>().is_none() {
        app.manage(Arc::new(Resources::default()));
    }
    app.state::<Arc<Resources>>().inner().clone()
}

#[tauri::command]
pub(crate) async fn prepare_plugin_resources(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
) -> Result<PreparedResources, String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    if app.get_webview_window(window.label()).is_none() {
        return Err("Plugin resource window is closed".into());
    }
    let resources = resources(&app);
    let preparation = resources.begin(owner)?;
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _execution = execution;
        if app.get_webview_window(&preparation.owner.window).is_none() {
            return Err("Plugin resource window is closed".into());
        }
        let (prepared, retired) = resources.commit_with_source_revoke(
            preparation,
            authorization(&db, &plugin_id)?,
            |owner| crate::plugin_window_sources::revoke_owner_bindings(&app, owner),
        )?;
        crate::plugin_window_sources::finish_revocations(&app, retired);
        Ok(prepared)
    })
    .await
    .map_err(|_| "Plugin resource preparation interrupted")?
}

#[tauri::command]
pub(crate) fn close_plugin_resources(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    if let Some(resources) = app.try_state::<Arc<Resources>>() {
        let retired = resources.close_with_source_revoke(&owner, |owner| {
            crate::plugin_window_sources::revoke_owner_bindings(&app, owner)
        });
        crate::plugin_window_sources::finish_revocations(&app, retired);
    } else {
        crate::plugin_window_sources::revoke_owner(&app, &owner);
    }
    Ok(())
}

pub(crate) fn invalidate_plugin(app: &AppHandle, plugin_id: &str) {
    if let Some(resources) = app.try_state::<Arc<Resources>>() {
        let retired = resources.invalidate_plugin_with_source_revoke(plugin_id, |plugin| {
            crate::plugin_window_sources::revoke_plugin_bindings(&app, plugin)
        });
        crate::plugin_window_sources::finish_revocations(app, retired);
    } else {
        crate::plugin_window_sources::revoke_plugin(app, plugin_id);
    }
}

pub(crate) fn close_window(app: &AppHandle, window: &str) {
    if let Some(resources) = app.try_state::<Arc<Resources>>() {
        let retired = resources.close_window_with_source_revoke(window, |window| {
            crate::plugin_window_sources::revoke_window_bindings(app, window)
        });
        crate::plugin_window_sources::finish_revocations(app, retired);
    } else {
        crate::plugin_window_sources::revoke_window(app, window);
    }
}

/// Validate that a source session belongs to the complete owner identity and still
/// matches the current package root and code revision.
pub(crate) fn validate_source_resources(
    app: &AppHandle,
    db: &Database,
    owner: &Owner,
    session_id: &str,
) -> Result<Authorization, String> {
    let resources = app
        .try_state::<Arc<Resources>>()
        .ok_or("Plugin resource session is unavailable")?;
    let lease = resources
        .get_for_owner(session_id, owner)
        .ok_or("Plugin resource session owner mismatch")?;
    let current = authorization(db, &owner.plugin)?;
    if lease.authorization != current {
        return Err("Plugin resource authorization has changed".into());
    }
    Ok(current)
}

#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn lease_count(app: &AppHandle) -> usize {
    app.try_state::<Arc<Resources>>()
        .map(|resources| resources.count())
        .unwrap_or(0)
}

/// Count-only diagnostics; do not initialize the lazy manager just to inspect it.
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) fn runtime_state(app: &AppHandle) -> serde_json::Value {
    app.try_state::<Arc<Resources>>()
        .map(|resources| resources.runtime_state())
        .unwrap_or_else(|| {
            serde_json::json!({"available":true,"leases":0,
            "preparations":0,"activeReads":0,"pendingRequests":0})
        })
}

/// Return only live leases whose owner and current DB authorization match the reviewed fixture.
/// IDs remain in the in-process fixture boundary and must never be written to reports or logs.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn resource_sessions_for_package(
    app: &AppHandle,
    window: &str,
    plugin_id: &str,
    expected_root: &Path,
) -> Result<Vec<String>, String> {
    let expected_canonical = std::fs::canonicalize(expected_root)
        .map_err(|_| "Expected plugin resource root is unavailable")?;
    if expected_canonical != expected_root || !expected_canonical.is_dir() {
        return Err("Expected plugin resource root must be canonical".into());
    }
    let state = app
        .try_state::<AppState>()
        .ok_or("Plugin application state is unavailable")?;
    let current = authorization(&state.db, plugin_id)?;
    if current.root != expected_canonical {
        return Err("Current plugin authorization does not match the expected root".into());
    }
    let Some(resources) = app.try_state::<Arc<Resources>>() else {
        return Ok(Vec::new());
    };
    resources.sessions_for_package(window, plugin_id, &current)
}

fn read_resource(
    db: &Database,
    lease: &Lease,
    resource: &request::ResourceRequest,
) -> Response<Vec<u8>> {
    let Ok(current) = authorization(db, &lease.owner.plugin) else {
        return request::error(StatusCode::FORBIDDEN, resource.head);
    };
    if current.root != lease.authorization.root || current.revision != lease.authorization.revision
    {
        return request::error(StatusCode::FORBIDDEN, resource.head);
    }
    if resource.options {
        return request::response(StatusCode::NO_CONTENT, resource.mime, Vec::new(), false);
    }
    match atools_plugin::package_resolution::read_package_asset_bytes(
        &current.root,
        &resource.relative,
        MAX_RESOURCE_BYTES,
    ) {
        Ok(Some(bytes)) => request::response(StatusCode::OK, resource.mime, bytes, resource.head),
        Ok(None) => request::error(StatusCode::NOT_FOUND, resource.head),
        Err(_) => request::error(StatusCode::FORBIDDEN, resource.head),
    }
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "atools-plugin",
        |context, request: Request<Vec<u8>>, responder| {
            let app = context.app_handle().clone();
            let head = request.method() == tauri::http::Method::HEAD;
            let Some(window) = app
                .get_webview_window(context.webview_label())
                .map(|view| view.label().to_string())
            else {
                responder.respond(request::error(StatusCode::NOT_FOUND, head));
                return;
            };
            let resource = match request::parse(&request) {
                Ok(value) => value,
                Err(status) => {
                    responder.respond(request::error(status, head));
                    return;
                }
            };
            let resources = resources(&app);
            let (lease, renderer_permit, window_document) =
                if let Some(document_id) = resource.window_document.as_deref() {
                    let document_access = app.try_state::<AppState>().and_then(|state| {
                        crate::plugin_window_sources::resolve_renderer_document_access(
                            &app,
                            &state.db,
                            &resources,
                            &resource.session,
                            &window,
                            document_id,
                            &resource.relative,
                        )
                    });
                    let Some((lease, permit, body)) = document_access else {
                        responder.respond(request::error(StatusCode::NOT_FOUND, head));
                        return;
                    };
                    (lease, Some(permit), Some(body))
                } else {
                    let access = if let Some(lease) = resources.get(&resource.session, &window) {
                        Some((lease, None))
                    } else {
                        app.try_state::<AppState>().and_then(|state| {
                            crate::plugin_window_sources::resolve_renderer_access(
                                &app,
                                &state.db,
                                &resources,
                                &resource.session,
                                &window,
                            )
                            .map(|(lease, permit)| (lease, Some(permit)))
                        })
                    };
                    let Some((lease, permit)) = access else {
                        responder.respond(request::error(StatusCode::NOT_FOUND, head));
                        return;
                    };
                    (lease, permit, None)
                };
            let Ok(pending) = resources.pending.clone().try_acquire_owned() else {
                responder.respond(request::error(StatusCode::SERVICE_UNAVAILABLE, head));
                return;
            };
            tauri::async_runtime::spawn(async move {
                let permit = match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    resources.reads.clone().acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        // Event-loop rejection drops the responder and bounded permit;
                        // it must not fall back to a worker-thread WebKit response.
                        let _ = handoff::enqueue(
                            pending,
                            |job| app.run_on_main_thread(job),
                            move || {
                                responder
                                    .respond(request::error(StatusCode::SERVICE_UNAVAILABLE, head));
                            },
                        );
                        return;
                    }
                };
                let execution = crate::plugin_lifecycle::execution(&app, &lease.owner.plugin).await;
                let db = app.state::<AppState>().db.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let renderer_still_current = renderer_permit
                        .as_ref()
                        .is_none_or(|permit| permit.matches_lease(&lease) && permit.is_active());
                    let lease_still_current =
                        resources.get_for_owner(&lease.id, &lease.owner).is_some();
                    let document_authorization_still_current =
                        window_document.as_ref().is_none_or(|_| {
                            authorization(&db, &lease.owner.plugin)
                                .is_ok_and(|current| current == lease.authorization)
                        });
                    let guards = (pending, permit, execution);
                    if let Some(body) = window_document {
                        if lease_still_current
                            && renderer_still_current
                            && document_authorization_still_current
                        {
                            if let Some(renderer) = renderer_permit {
                                let _ = handoff::dispatch_window_document(
                                    resources,
                                    lease,
                                    body,
                                    resource.mime,
                                    head,
                                    resource.options,
                                    guards,
                                    renderer,
                                    |job| app.run_on_main_thread(job),
                                    move |response| responder.respond(response),
                                );
                            } else {
                                let response = request::error(StatusCode::NOT_FOUND, head);
                                let _ = handoff::dispatch_with_renderer(
                                    resources,
                                    lease,
                                    response,
                                    head,
                                    guards,
                                    None,
                                    |job| app.run_on_main_thread(job),
                                    move |response| responder.respond(response),
                                );
                            }
                        } else {
                            let response = request::error(StatusCode::NOT_FOUND, head);
                            let _ = handoff::dispatch_with_renderer(
                                resources,
                                lease,
                                response,
                                head,
                                guards,
                                renderer_permit,
                                |job| app.run_on_main_thread(job),
                                move |response| responder.respond(response),
                            );
                        }
                    } else {
                        let response = if lease_still_current && renderer_still_current {
                            read_resource(&db, &lease, &resource)
                        } else {
                            request::error(StatusCode::NOT_FOUND, head)
                        };
                        let _ = handoff::dispatch_with_renderer(
                            resources,
                            lease,
                            response,
                            head,
                            guards,
                            renderer_permit,
                            |job| app.run_on_main_thread(job),
                            move |response| responder.respond(response),
                        );
                    }
                })
                .await
                .ok();
            });
        },
    )
}

#[cfg(test)]
mod handoff_tests;
#[cfg(test)]
mod tests;
