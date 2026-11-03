//! One bounded pending operation per actual WebView; no additional renderer IPC command.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, Webview, Wry};
use tokio::sync::oneshot;

const LIMIT: usize = 64 * 1024;
const STEP_TIMEOUT: Duration = Duration::from_secs(8);

pub(super) struct Transport {
    seen: HashSet<String>,
    documents: HashMap<String, String>,
    completed: usize,
    child_checks: usize,
}

impl Transport {
    pub(super) fn new() -> Self {
        Self {
            seen: HashSet::new(),
            documents: HashMap::new(),
            completed: 0,
            child_checks: 0,
        }
    }
    pub(super) fn nonce_bound(&self) -> bool {
        self.completed > 0 && self.completed == self.seen.len()
    }
    pub(super) fn child_role_bound(&self) -> bool {
        self.child_checks > 0
    }

    pub(super) async fn call(
        &mut self,
        app: &AppHandle<Wry>,
        webview: &Webview<Wry>,
        session: Option<&str>,
        op: &str,
        arg: Value,
    ) -> Result<Value, &'static str> {
        validate(app, webview, session, op == "navigate")?;
        let role = if session.is_some() { "child" } else { "main" };
        let install = include_str!("settings_registration_probe.js")
            .replace(
                "__ATOOLS_SETTINGS_REGISTRATION_ROLE__",
                &json!(role).to_string(),
            )
            .replace(
                "__ATOOLS_SETTINGS_REGISTRATION_DOCUMENT__",
                &json!(uuid::Uuid::new_v4().simple().to_string()).to_string(),
            );
        webview
            .eval(install)
            .map_err(|_| "settings-registration-probe-injection-failed")?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        if !self.seen.insert(nonce.clone()) {
            return Err("settings-registration-nonce-reused");
        }
        let start = format!(
            "window.__ATOOLS_SETTINGS_REGISTRATION__?.start({},{},{}) ?? false",
            json!(nonce),
            json!(op),
            arg
        );
        if evaluate(webview, &start).await? != Value::Bool(true) {
            return Err("settings-registration-probe-busy");
        }
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        loop {
            validate(app, webview, session, op == "navigate")?;
            let script = format!(
                "window.__ATOOLS_SETTINGS_REGISTRATION__?.read({}) ?? null",
                json!(nonce)
            );
            let reply = evaluate(webview, &script).await?;
            if reply["nonce"].as_str() != Some(nonce.as_str())
                || reply["role"].as_str() != Some(role)
            {
                return Err("settings-registration-probe-receipt-rejected");
            }
            let document = reply["documentId"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or("settings-registration-document-invalid")?;
            let key = webview.label().to_owned();
            if self
                .documents
                .get(&key)
                .is_some_and(|previous| previous != document)
            {
                return Err("settings-registration-document-changed-unexpectedly");
            }
            self.documents
                .entry(key)
                .or_insert_with(|| document.to_owned());
            if session.is_some() {
                self.child_checks += 1;
            }
            if reply["done"] == true {
                self.completed += 1;
                if reply["value"].is_null() {
                    return Err("settings-registration-probe-operation-failed");
                }
                return Ok(json!({ "documentId": document, "result": reply["value"] }));
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = webview.eval(format!(
                    "window.__ATOOLS_SETTINGS_REGISTRATION__?.cancel({})",
                    json!(nonce)
                ));
                return Err("settings-registration-probe-timeout");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

fn validate(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    session: Option<&str>,
    allow_general: bool,
) -> Result<(), &'static str> {
    if webview.window().label() != "main" || app.get_webview(webview.label()).is_none() {
        return Err("settings-registration-webview-role-rejected");
    }
    let url = webview
        .url()
        .map_err(|_| "settings-registration-webview-role-rejected")?;
    if let Some(id) = session {
        let state = crate::renderer_settings_view::snapshot(app);
        let children: Vec<_> = webview
            .window()
            .webviews()
            .into_iter()
            .filter(|child| child.label().starts_with("ztools-settings-"))
            .collect();
        if webview.label() != format!("ztools-settings-{id}")
            || children.len() != 1
            || children[0].label() != webview.label()
            || !crate::renderer_settings_view::is_expected_settings_url(&url, id)
            || (!allow_general
                && !url.fragment().is_some_and(|fragment| {
                    fragment == "/localLaunch" || fragment.starts_with("/localLaunch?_t=")
                }))
            || state["sessionCount"] != 1
            || state["phase"] != "open"
            || state["ready"] != true
            || state["childPresent"] != true
            || state["documentAuthorized"] != true
        {
            return Err("settings-registration-webview-role-rejected");
        }
    } else if webview.label() != "main"
        || !super::super::controller::is_local_root_url(&url)
        || crate::window::main_webview(app)
            .map(|main| main.label() != webview.label())
            .unwrap_or(true)
    {
        return Err("settings-registration-webview-role-rejected");
    }
    Ok(())
}

async fn evaluate(webview: &Webview<Wry>, script: &str) -> Result<Value, &'static str> {
    let (sender, receiver) = oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(sender)));
    let callback_pending = Arc::clone(&pending);
    webview
        .eval_with_callback(script, move |reply: String| {
            let reply = (reply.len() <= LIMIT).then_some(reply);
            if let Some(sender) = callback_pending.lock().take() {
                let _ = sender.send(reply);
            }
        })
        .map_err(|_| "settings-registration-probe-eval-failed")?;
    let reply = match tokio::time::timeout(Duration::from_secs(2), receiver).await {
        Ok(Ok(Some(reply))) => reply,
        _ => {
            pending.lock().take();
            return Err("settings-registration-probe-read-timeout");
        }
    };
    serde_json::from_str(&reply).map_err(|_| "settings-registration-probe-receipt-rejected")
}
