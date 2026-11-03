//! Fixed Shortcuts/global intent. Eval submission is followed by a native ACK.
use super::{
    intent_protocol::{self, parse_ack, ACK_TIMEOUT},
    main_authority::{capture_main, CapturedMain},
    open_claims::ClaimKind,
    open_service::{open_prepared, RequestObserver},
    session::SessionView,
    validation::{ensure_still_active, inactive_session, BridgeError},
};
use atools_core::db::{RendererAppIdentity, RendererDirectSubtype};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview, Window};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AppInput {
    path: String,
    name: String,
    sub_type: String,
}

#[tauri::command]
pub(crate) async fn open_renderer_app_shortcuts(
    handle: AppHandle,
    webview: Webview,
    window: Window,
    app: AppInput,
) -> Result<Value, BridgeError> {
    let main = capture_main(&handle, &webview, &window)?;
    let target = RendererAppIdentity {
        path: app.path,
        name: app.name,
        sub_type: RendererDirectSubtype::App,
    };
    if app.sub_type != "app" || crate::renderer_app_state::validate_identity(&target).is_err() {
        return Err(rejected());
    }
    let runtime = super::runtime(&handle).map_err(|_| inactive_session())?;
    // Admission order, never catalog completion order, determines latest intent.
    let (claim, sequence, tickets) = runtime
        .admit_request(main.key, ClaimKind::AppIntent)
        .map_err(|_| inactive_session())?;
    super::open_service::cleanup_tickets(&handle, tickets);
    let observer = RequestObserver::new(handle.clone(), claim).map_err(|_| inactive_session())?;
    let sequence = sequence
        .filter(|n| *n <= intent_protocol::MAX_SEQUENCE)
        .ok_or_else(rejected)?;
    let state = handle.state::<crate::state::AppState>();
    check_admitted_catalog(
        crate::renderer_app_state::catalog_contains_identity(
            state.launcher_app_catalog.clone(),
            &target,
        ),
        || {
            main.validate(&handle)?;
            if !runtime.open_claim_live(claim) {
                return Err(rejected());
            }
            Ok(())
        },
    )
    .await?;
    let envelope = open_prepared(handle.clone(), state.db.clone(), main.clone(), observer)
        .await
        .map_err(|_| inactive_session())?;
    main.validate(&handle)?;
    let session_id = envelope
        .receipt
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(inactive_session)?;
    let session = runtime
        .current_for_id(session_id)
        .map_err(|_| inactive_session())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let receiver = runtime
        .reserve_intent(id.clone(), sequence, &session, claim, main.key)
        .map_err(|_| inactive_session())?;
    let payload = json!({"version":1,"id":id,"sessionId":session_id,"sequence":sequence,
        "target":{"kind":"app","path":target.path,"name":target.name}});
    let encoded = serde_json::to_string(&payload).map_err(|_| rejected())?;
    let acknowledged = wait_for_consumption(
        deliver(&handle, main, session, id.clone(), sequence, claim, encoded),
        receiver,
        ACK_TIMEOUT,
    )
    .await;
    if !acknowledged {
        if let Some(ticket) = runtime.cancel_intent(&id, sequence, claim) {
            super::open_service::cleanup_tickets(&handle, vec![ticket]);
        }
        return Err(BridgeError::new(
            "SETTINGS_APP_SHORTCUT_INTENT_UNCONFIRMED",
            "The App shortcut intent was not accepted",
        ));
    }
    // ACK adopted atomically under the same lock as observer cancellation.
    // Dropping this observer is now harmless; adoption removed its claim.
    Ok(envelope.receipt)
}

async fn check_admitted_catalog(
    lookup: impl std::future::Future<Output = Result<bool, String>>,
    revalidate: impl FnOnce() -> Result<(), BridgeError>,
) -> Result<(), BridgeError> {
    let valid = lookup.await.map_err(|_| rejected())?;
    revalidate()?;
    if valid {
        Ok(())
    } else {
        Err(rejected())
    }
}

async fn wait_for_consumption(
    delivery: impl std::future::Future<Output = Result<(), BridgeError>>,
    receiver: tokio::sync::oneshot::Receiver<bool>,
    deadline: std::time::Duration,
) -> bool {
    matches!(
        tokio::time::timeout(deadline, async {
            delivery.await?;
            receiver.await.map_err(|_| inactive_session())
        })
        .await,
        Ok(Ok(true))
    )
}

async fn deliver(
    app: &AppHandle,
    main: CapturedMain,
    session: SessionView,
    id: String,
    sequence: u64,
    claim: super::open_claims::ClaimId,
    encoded: String,
) -> Result<(), BridgeError> {
    let delivery_app = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            main.validate(&delivery_app)?;
            ensure_still_active(&delivery_app, &session)?;
            let runtime = super::runtime(&delivery_app).map_err(|_| inactive_session())?;
            if !runtime.intent_pending(&id, sequence, claim, &session) { return Err(inactive_session()); }
            let child = delivery_app.get_webview(&session.label).ok_or_else(inactive_session)?;
            let url = child.url().map_err(|_| inactive_session())?;
            if !session.signal().ready || child.window().label() != "main"
                || !super::main_authority::same_window(&child.window(), &main.window)
                || !super::identity::is_expected_settings_url(&url, &session.id) { return Err(inactive_session()); }
            let script = format!("(()=>{{const receive=window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__;if(typeof receive!=='function')throw new Error('Settings intent receiver unavailable');receive({encoded});}})()");
            child.eval(&script).map_err(|_| rejected())
        })();
        let _ = tx.send(result);
    }).map_err(|_| rejected())?;
    rx.await.map_err(|_| rejected())?
}

pub(super) fn acknowledge(
    app: &AppHandle,
    webview: &Webview,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let ack = parse_ack(payload)?;
    ensure_still_active(app, session)?;
    let current = app
        .get_webview(&session.label)
        .ok_or_else(inactive_session)?;
    let url = webview.url().map_err(|_| inactive_session())?;
    if !super::main_authority::same_webview(&current, webview)
        || !session.signal().ready
        || session.signal().phase != super::phase::SessionPhase::Open
        || session.bundle.revision() != session.bundle_revision
        || !super::identity::is_expected_settings_url(&url, &session.id)
        || (ack.accepted && !intent_protocol::is_shortcuts_route(&url, &session.id))
    {
        return Err(inactive_session());
    }
    let ticket = super::runtime(app)
        .map_err(|_| inactive_session())?
        .acknowledge_intent(session, ack)
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_APP_SHORTCUT_ACK_REJECTED",
                "The App shortcut acknowledgement is stale",
            )
        })?;
    if let Some(ticket) = ticket {
        super::open_service::cleanup_tickets(app, vec![ticket]);
    }
    Ok(json!({"acknowledged":true}))
}

fn rejected() -> BridgeError {
    BridgeError::new(
        "SETTINGS_APP_SHORTCUT_TARGET_REJECTED",
        "The App shortcut target is not available",
    )
}

#[cfg(test)]
#[path = "app_shortcuts_intent_tests.rs"]
mod tests;
