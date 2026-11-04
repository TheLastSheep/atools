//! Bounded ownership of FeatureCode actions across Native-to-Main delivery.
use super::recording_gate::{ActionPermit, Receipt};
use crate::{general_settings_runtime::GeneralSettingsCoordinator, state::AppState};
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Weak},
};
use tauri::{AppHandle, Manager, Webview, Window, Wry};

const LIMIT: usize = 128;
const INVALID: &str = "SHORTCUT_DISPATCH_UNAVAILABLE";
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone)]
pub(crate) struct Owner {
    webview: Webview<Wry>,
    window: Window<Wry>,
    source: tauri::Url,
}
fn same_view(a: &Webview<Wry>, b: &Webview<Wry>) -> bool {
    let a = &*a.resources_table() as *const _ as usize;
    let b = &*b.resources_table() as *const _ as usize;
    a == b
}
fn same_window(a: &Window<Wry>, b: &Window<Wry>) -> bool {
    let a = &*a.resources_table() as *const _ as usize;
    let b = &*b.resources_table() as *const _ as usize;
    a == b
}
// A WebviewWindow exists only for a native window containing one Webview.
// Multi-Webview Main must use the independent parent and root Webview getters.
fn current_main(app: &AppHandle) -> Option<(Webview<Wry>, Window<Wry>)> {
    #[cfg(feature = "ztools-multiwebview")]
    {
        Some((app.get_webview("main")?, app.get_window("main")?))
    }
    #[cfg(not(feature = "ztools-multiwebview"))]
    {
        let main = app.get_webview_window("main")?;
        let view = AsRef::<Webview<Wry>>::as_ref(&main).clone();
        let window = view.window();
        Some((view, window))
    }
}
pub(crate) fn main_webview(app: &AppHandle) -> Option<Webview<Wry>> {
    current_main(app).map(|(view, _)| view)
}
pub(crate) trait OwnerIdentity: Clone {
    fn matches(&self, other: &Self) -> bool;
}
impl Owner {
    fn capture(app: &AppHandle, view: &Webview<Wry>) -> Result<Self, String> {
        let window = view.window();
        let (current_view, current_window) = current_main(app).ok_or(INVALID)?;
        if view.label() != "main"
            || window.label() != "main"
            || !same_view(&current_view, view)
            || !same_window(&current_window, &window)
        {
            return Err(INVALID.into());
        }
        Ok(Self {
            webview: view.clone(),
            window,
            source: view.url().map_err(|_| INVALID)?,
        })
    }
}
impl OwnerIdentity for Owner {
    fn matches(&self, other: &Self) -> bool {
        self.source == other.source
            && same_view(&self.webview, &other.webview)
            && same_window(&self.window, &other.window)
    }
}
struct Ticket<O: OwnerIdentity> {
    owner: O,
    code: String,
    plugin_id: String,
    receipt: Weak<Receipt>,
    epoch: u64,
    permit: Arc<ActionPermit>,
    claimed: bool,
}
struct State<O: OwnerIdentity> {
    tickets: BTreeMap<String, Ticket<O>>,
    completed: VecDeque<(String, O, String)>,
    registrations: BTreeMap<u32, Weak<Receipt>>,
}
impl<O: OwnerIdentity> Default for State<O> {
    fn default() -> Self {
        Self {
            tickets: BTreeMap::new(),
            completed: VecDeque::new(),
            registrations: BTreeMap::new(),
        }
    }
}
pub(crate) struct Ledger<O: OwnerIdentity = Owner> {
    state: Mutex<State<O>>,
}
impl<O: OwnerIdentity> Default for Ledger<O> {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
        }
    }
}
fn ledger(app: &AppHandle) -> Result<Arc<Ledger>, String> {
    app.try_state::<GeneralSettingsCoordinator>()
        .map(|c| c.feature_dispatch.clone())
        .ok_or(INVALID.into())
}
impl<O: OwnerIdentity> Ledger<O> {
    fn offer(
        &self,
        owner: O,
        code: String,
        plugin_id: String,
        receipt: Weak<Receipt>,
        epoch: u64,
        permit: Arc<ActionPermit>,
    ) -> Result<String, String> {
        let mut state = self.state.lock();
        if state.tickets.len() >= LIMIT {
            return Err(INVALID.into());
        }
        let current = receipt.upgrade().ok_or(INVALID)?;
        let _admission = current.admit(epoch).ok_or(INVALID)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        if state.tickets.contains_key(&id) {
            return Err(INVALID.into());
        }
        state.tickets.insert(
            id.clone(),
            Ticket {
                owner,
                code,
                plugin_id,
                receipt,
                epoch,
                permit,
                claimed: false,
            },
        );
        Ok(id)
    }
    fn claim(
        &self,
        owner: &O,
        id: &str,
        code: &str,
        plugin: Option<&str>,
    ) -> Result<Arc<ActionPermit>, String> {
        if !valid_id(id) {
            return Err(INVALID.into());
        }
        let mut state = self.state.lock();
        let ticket = state.tickets.get_mut(id).ok_or(INVALID)?;
        if ticket.claimed
            || !ticket.owner.matches(owner)
            || ticket.code != code
            || Some(ticket.plugin_id.as_str()) != plugin
        {
            return Err(INVALID.into());
        }
        let receipt = ticket.receipt.upgrade().ok_or(INVALID)?;
        let _identity_permit = receipt.admit(ticket.epoch).ok_or(INVALID)?;
        ticket.claimed = true;
        Ok(ticket.permit.clone())
    }
    fn complete(&self, owner: &O, id: &str, outcome: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err(INVALID.into());
        }
        let removed = {
            let mut state = self.state.lock();
            if let Some((_, old_owner, old_outcome)) =
                state.completed.iter().find(|(old, _, _)| old == id)
            {
                return if old_owner.matches(owner) && old_outcome == outcome {
                    Ok(())
                } else {
                    Err(INVALID.into())
                };
            }
            let ticket = state.tickets.get(id).ok_or(INVALID)?;
            if !ticket.owner.matches(owner) || (!ticket.claimed && outcome == "committed") {
                return Err(INVALID.into());
            }
            let ticket = state.tickets.remove(id).ok_or(INVALID)?;
            if state.completed.len() == LIMIT {
                state.completed.pop_front();
            }
            state
                .completed
                .push_back((id.to_owned(), owner.clone(), outcome.to_owned()));
            ticket
        };
        drop(removed);
        Ok(())
    }
    fn remove_where(&self, mut predicate: impl FnMut(&Ticket<O>) -> bool) {
        let removed = {
            let mut state = self.state.lock();
            let ids: Vec<_> = state
                .tickets
                .iter()
                .filter(|(_, t)| predicate(t))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| state.tickets.remove(&id))
                .collect::<Vec<_>>()
        };
        drop(removed);
    }
}
pub(crate) fn offer(
    app: &AppHandle,
    view: &Webview<Wry>,
    code: String,
    plugin_id: String,
    receipt: Weak<Receipt>,
    epoch: u64,
    permit: Arc<ActionPermit>,
) -> Result<String, String> {
    ledger(app)?.offer(
        Owner::capture(app, view)?,
        code,
        plugin_id,
        receipt,
        epoch,
        permit,
    )
}
pub(crate) fn publish_registration(
    app: &AppHandle,
    id: u32,
    receipt: &Arc<Receipt>,
) -> Result<(), String> {
    ledger(app)?
        .state
        .lock()
        .registrations
        .insert(id, Arc::downgrade(receipt));
    Ok(())
}
pub(crate) fn retire_registration(app: &AppHandle, id: u32) -> Result<(), String> {
    let old = ledger(app)?.state.lock().registrations.remove(&id);
    if let Some(receipt) = old.and_then(|v| v.upgrade()) {
        receipt.retire();
    }
    Ok(())
}
pub(crate) fn cancel_offers(app: &AppHandle) {
    if let Ok(ledger) = ledger(app) {
        ledger.remove_where(|ticket| !ticket.claimed);
    }
}
pub(crate) fn cancel_offer(app: &AppHandle, id: &str) {
    if let Ok(ledger) = ledger(app) {
        let removed = {
            let mut state = ledger.state.lock();
            if state.tickets.get(id).is_some_and(|t| !t.claimed) {
                state.tickets.remove(id)
            } else {
                None
            }
        };
        drop(removed);
    }
}
pub(crate) fn destroy_main(window: &Window<Wry>) {
    if let Ok(ledger) = ledger(window.app_handle()) {
        ledger.remove_where(|ticket| same_window(&ticket.owner.window, window));
    }
}

#[tauri::command]
pub async fn activate_feature(
    app: AppHandle,
    webview: Webview<Wry>,
    state: tauri::State<'_, AppState>,
    code: String,
    payload: Option<serde_json::Value>,
    expected_plugin_id: Option<String>,
    shortcut_dispatch_id: Option<String>,
) -> Result<crate::commands::FeatureAction, String> {
    if let Some(id) = shortcut_dispatch_id {
        if !valid_id(&id) {
            return Err(INVALID.into());
        }
        let permit = ledger(&app)?.claim(
            &Owner::capture(&app, &webview)?,
            &id,
            &code,
            expected_plugin_id.as_deref(),
        )?;
        let task_app = app.clone();
        return tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let state = task_app.state::<AppState>();
            crate::feature_activation::activate(
                &task_app,
                &state,
                &code,
                payload,
                expected_plugin_id.as_deref(),
            )
            .await
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    crate::feature_activation::activate(&app, &state, &code, payload, expected_plugin_id.as_deref())
        .await
}
#[tauri::command]
pub async fn complete_native_shortcut_action(
    app: AppHandle,
    webview: Webview<Wry>,
    dispatch_id: String,
    outcome: String,
) -> Result<(), String> {
    if !valid_id(&dispatch_id) || !matches!(outcome.as_str(), "committed" | "failed" | "superseded")
    {
        return Err(INVALID.into());
    }
    ledger(&app)?.complete(&Owner::capture(&app, &webview)?, &dispatch_id, &outcome)
}
#[cfg(test)]
#[path = "feature_dispatch_tests.rs"]
mod tests;
