//! Fixed public Main entry and bounded read-only adapter receipts; no new IPC or DOM driver.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[path = "main_dispatch_once.rs"]
mod dispatch_once;
#[path = "main_load.rs"]
mod load;
pub(super) use load::{on_page_load, Runtime as LoadRuntime};

const READ: &str = r#"function(){
 const empty={available:false,called:false,client:null,windowNotifications:null,
 probe:{readyState:"unknown",href:"",publicApi:"undefined",adapter:"undefined",error:false}};
 try {
 empty.probe={readyState:document.readyState,href:location.href,publicApi:typeof window.ztools?.openSettings,
 adapter:typeof window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot,error:false};
 const h=window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.(); const s=h?.settingsView,n=h?.windowNotifications;
 if(!s || !n || typeof window.ztools?.openSettings!=='function') return empty;
 return {...empty,available:true,client:{version:s.version,listenerState:s.listenerState,activePhase:s.activePhase,
 pendingOpen:s.pendingOpen,openFailures:s.openFailures,closeFailures:s.closeFailures,invalidPayloads:s.invalidPayloads,
 registrationErrors:s.registrationErrors,lateListenerUnlistens:s.lateListenerUnlistens,cleanupErrors:s.cleanupErrors},
 windowNotifications:{pendingReplies:n.pendingReplies,failures:n.failures,cancelled:n.cancelled,dropped:n.dropped}};
 } catch (_) { empty.probe.error=true; return empty; }
}"#;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    available: bool,
    called: bool,
    client: Option<Client>,
    window_notifications: Option<Notifications>,
    probe: Probe,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Probe {
    ready_state: String,
    href: String,
    public_api: String,
    adapter: String,
    error: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Notifications {
    pending_replies: u32,
    failures: u32,
    cancelled: u32,
    dropped: u32,
}
impl Notifications {
    fn drained(&self) -> bool {
        self.pending_replies == 0 && self.failures == 0 && self.cancelled == 0 && self.dropped == 0
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Client {
    version: u32,
    listener_state: String,
    active_phase: Option<String>,
    pending_open: bool,
    open_failures: u32,
    close_failures: u32,
    invalid_payloads: u32,
    registration_errors: u32,
    late_listener_unlistens: u32,
    cleanup_errors: u32,
}
impl Client {
    fn healthy(&self) -> bool {
        self.version == 1
            && self.listener_state == "listening"
            && [
                self.open_failures,
                self.close_failures,
                self.invalid_payloads,
                self.registration_errors,
                self.late_listener_unlistens,
                self.cleanup_errors,
            ] == [0; 6]
    }
    fn at(&self, phase: &str) -> bool {
        self.healthy() && !self.pending_open && self.active_phase.as_deref() == Some(phase)
    }
}
#[derive(Clone, Copy)]
enum Action {
    Observe,
    Open,
}
fn script(action: Action) -> String {
    match action {
        Action::Observe=>format!("({READ})()"),
        Action::Open=>format!("(()=>{{const read={READ}; const r=read(); if(!r.available || r.probe.error || r.probe.readyState!=='complete' || r.windowNotifications.pendingReplies!==0 || r.windowNotifications.failures!==0 || r.windowNotifications.cancelled!==0 || r.windowNotifications.dropped!==0 || r.client.listenerState!=='listening' || r.client.pendingOpen || ![null,'back-to-search'].includes(r.client.activePhase)) return r; try {{ window.ztools.openSettings(); const after=read(); after.called=true; return after; }} catch (_) {{ r.probe.error=true; r.called=true; return r; }}}})()"),
    }
}
async fn evaluate(app: &AppHandle, action: Action) -> Result<Receipt, String> {
    super::validate(app)?;
    let main = crate::window::main_webview(app).map_err(|e| e.to_string())?;
    let url = main.url().map_err(|e| e.to_string())?;
    if main.label() != "main" || main.window().label() != "main" || !load::trusted(&url) {
        return Err("height Main document identity rejected".into());
    }
    let epoch = app.state::<LoadRuntime>().snapshot();
    if !epoch.finished {
        return Err("height Main navigation not finished".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = Arc::new(Mutex::new(Some(send)));
    main.eval_with_callback(script(action), move |value| {
        if let Some(send) = send.lock().unwrap().take() {
            let _ = send.send(value);
        }
    })
    .map_err(|e| e.to_string())?;
    let value = tokio::time::timeout(Duration::from_secs(3), receive)
        .await
        .map_err(|_| "height Main callback timed out")?
        .map_err(|_| {
            format!(
                "height Main callback closed: native={url} epoch={} finished={}",
                epoch.epoch, epoch.finished
            )
        })?;
    if value.len() > 4096 {
        return Err("height Main receipt exceeded budget".into());
    }
    super::validate(app)?;
    if main.url().ok().as_ref() != Some(&url) {
        return Err("height Main document changed during callback".into());
    }
    let after = app.state::<LoadRuntime>().snapshot();
    if epoch.epoch != after.epoch || !after.finished {
        return Err("height Main navigation epoch changed".into());
    }
    serde_json::from_str(&value).map_err(|_| "height Main receipt shape rejected".into())
}

async fn ready(app: &AppHandle) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    let mut last = String::from("no trusted Main Finished observation");
    loop {
        let runtime = app.state::<LoadRuntime>();
        let changed = runtime.changed.notified();
        let epoch = runtime.snapshot();
        if epoch.finished {
            match evaluate(app, Action::Observe).await {
                Ok(receipt) if receipt.ready() => return Ok(()),
                Ok(receipt) if receipt.probe.error => {
                    return Err("height Main observation threw".into())
                }
                Ok(receipt) => {
                    last = format!(
                        "epoch={} document={} publicApi={} adapter={} locationTrusted={}",
                        epoch.epoch,
                        receipt.probe.ready_state,
                        receipt.probe.public_api,
                        receipt.probe.adapter,
                        receipt
                            .probe
                            .href
                            .parse()
                            .is_ok_and(|url| load::trusted(&url))
                    );
                }
                Err(error) => {
                    let after = runtime.snapshot();
                    if after.finished && after.epoch == epoch.epoch {
                        return Err(error);
                    }
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("height Main readiness deadline: {last}"));
        }
        // Event-driven while loading; bounded pure observations while adapter bootstrap completes.
        let tick = tokio::time::sleep(Duration::from_millis(30));
        tokio::select! { _ = changed => {}, _ = tick => {} }
    }
}
impl Receipt {
    fn ready(&self) -> bool {
        self.available
            && !self.probe.error
            && self.probe.ready_state == "complete"
            && self.probe.public_api == "function"
            && self.probe.adapter == "function"
            && self.probe.href.parse().is_ok_and(|url| load::trusted(&url))
            && self.client.as_ref().is_some_and(|client| {
                client.healthy()
                    && !client.pending_open
                    && matches!(
                        client.active_phase.as_deref(),
                        None | Some("back-to-search")
                    )
            })
            && self
                .window_notifications
                .as_ref()
                .is_some_and(Notifications::drained)
    }
}
pub(super) async fn open(app: &AppHandle) -> Result<(), String> {
    ready(app).await?;
    dispatch_once::run(
        || async {
            let receipt = evaluate(app, Action::Open).await?;
            if receipt.called
                && !receipt.probe.error
                && receipt.client.as_ref().is_some_and(Client::healthy)
            {
                Ok(())
            } else {
                Err("height Main open entry failed".into())
            }
        },
        || async {
            // A lost action acknowledgement is UNKNOWN, including Wry's queued late execution.
            // Observe the actual public client AND native child, never resend the public action.
            wait(app, "loaded").await?;
            let state = crate::renderer_settings_view::snapshot(app);
            if state["sessionCount"].as_u64() == Some(1)
                && state["childPresent"].as_bool() == Some(true)
            {
                Ok(())
            } else {
                Err("height Main open outcome unknown".into())
            }
        },
    )
    .await
}
pub(super) async fn wait(app: &AppHandle, phase: &str) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        let receipt = evaluate(app, Action::Observe).await?;
        if receipt.available
            && receipt
                .client
                .as_ref()
                .is_some_and(|client| client.at(phase))
            && receipt
                .window_notifications
                .as_ref()
                .is_some_and(Notifications::drained)
        {
            return Ok(
                serde_json::json!({"client":receipt.client,"windowNotifications":receipt.window_notifications}),
            );
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("height Main did not reach {phase}"));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

pub(super) fn receipt_healthy(client: &Value, notifications: &Value, phase: &str) -> bool {
    serde_json::from_value::<Client>(client.clone()).is_ok_and(|client| client.at(phase))
        && serde_json::from_value::<Notifications>(notifications.clone())
            .is_ok_and(|state| state.drained())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_entry_is_public_client_and_only_real_loaded_back_receipts_are_accepted() {
        assert!(script(Action::Open).contains("window.ztools.openSettings()"));
        assert!(!script(Action::Open).contains("open_renderer_settings"));
        assert!(!script(Action::Observe).contains(".openSettings()"));
        let mut client = Client {
            version: 1,
            listener_state: "listening".into(),
            active_phase: Some("loaded".into()),
            pending_open: false,
            open_failures: 0,
            close_failures: 0,
            invalid_payloads: 0,
            registration_errors: 0,
            late_listener_unlistens: 0,
            cleanup_errors: 0,
        };
        assert!(client.at("loaded"));
        assert!(!client.at("back-to-search"));
        client.pending_open = true;
        assert!(!client.at("loaded"));
        client.pending_open = false;
        client.active_phase = Some("back-to-search".into());
        assert!(client.at("back-to-search"));
        client.open_failures = 1;
        assert!(!client.at("back-to-search"));
        assert!(serde_json::from_value::<Receipt>(
            serde_json::json!({"available":true,"called":true,"client":null,"arbitrary":"js"})
        )
        .is_err());
    }
    #[test]
    fn observation_is_defensive_json_and_ready_requires_document_api_and_healthy_idle_client() {
        assert!(script(Action::Observe).contains("catch (_)"));
        assert!(!script(Action::Observe).contains("window.ztools.openSettings()"));
        let value = serde_json::json!({"available":true,"called":false,
            "client":{"version":1,"listenerState":"listening","activePhase":null,"pendingOpen":false,
                "openFailures":0,"closeFailures":0,"invalidPayloads":0,"registrationErrors":0,
                "lateListenerUnlistens":0,"cleanupErrors":0},
            "windowNotifications":{"pendingReplies":0,"failures":0,"cancelled":0,"dropped":0},
            "probe":{"readyState":"complete","href":"tauri://localhost/","publicApi":"function","adapter":"function","error":false}});
        let mut receipt: Receipt = serde_json::from_value(value).unwrap();
        assert!(receipt.ready());
        receipt.probe.ready_state = "loading".into();
        assert!(!receipt.ready());
        receipt.probe.ready_state = "complete".into();
        receipt.probe.error = true;
        assert!(!receipt.ready());
        receipt.probe.error = false;
        receipt.client.as_mut().unwrap().pending_open = true;
        assert!(!receipt.ready());
    }
}
