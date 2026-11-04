//! Ephemeral dispatch validity, projected only from the owned Main registry.
use super::main_binding::MainBinding;
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Weak,
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(crate) struct Token {
    generation: AtomicU64,
    epoch: AtomicU64,
    exhausted: AtomicBool,
    pub(super) receipt: Mutex<Option<Arc<crate::app_global_shortcuts::recording_gate::Receipt>>>,
}
impl Token {
    pub(super) fn invalidate_pending(&self) {
        // One atomic stamp is the whole dispatch predicate: no cross-load ABA.
        if self
            .epoch
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |stamp| {
                stamp.checked_add(2)
            })
            .is_err()
        {
            self.exhausted.store(true, Ordering::Release);
            self.epoch.store(0, Ordering::Release);
        }
    }
    fn publish(&self, generation: u64) {
        if self.exhausted.load(Ordering::Acquire) {
            return;
        }
        if self.generation.swap(generation, Ordering::AcqRel) != generation {
            let result = self
                .epoch
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |stamp| {
                    stamp
                        .checked_add(2)
                        .map(|next| (next & !1) | u64::from(generation != 0))
                });
            if result.is_err() {
                self.exhausted.store(true, Ordering::Release);
                self.epoch.store(0, Ordering::Release);
            }
        }
    }
    fn valid(&self, stamp: u64) -> bool {
        stamp & 1 == 1 && self.epoch.load(Ordering::Acquire) == stamp
    }
}

struct Registration {
    binding: MainBinding,
    token: Arc<Token>,
    native: Option<super::double_tap_native::Lease>,
}
#[derive(Default)]
pub(crate) struct Runtime {
    entries: Mutex<Vec<Registration>>,
    pub(super) closed: AtomicBool,
}
fn runtime(app: &AppHandle) -> Result<tauri::State<'_, Runtime>, String> {
    app.try_state::<Runtime>()
        .ok_or_else(|| "SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into())
}
pub(super) fn pending(app: &AppHandle, binding: MainBinding) -> Result<Arc<Token>, String> {
    let runtime = runtime(app)?;
    if runtime.closed.load(Ordering::Acquire) {
        return Err("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into());
    }
    let mut entries = runtime.entries.lock();
    if entries.iter().any(|entry| entry.binding == binding) {
        return Err("SETTINGS_HOTKEY_REJECTED".into());
    }
    let token = Arc::new(Token::default());
    entries.push(Registration {
        binding,
        token: token.clone(),
        native: None,
    });
    Ok(token)
}
pub(super) fn attach(
    app: &AppHandle,
    binding: MainBinding,
    lease: super::double_tap_native::Lease,
) -> Result<(), String> {
    let runtime = runtime(app)?;
    let mut entries = runtime.entries.lock();
    let entry = entries
        .iter_mut()
        .find(|entry| entry.binding == binding)
        .ok_or("SETTINGS_HOTKEY_OUTCOME_UNKNOWN")?;
    entry.native = Some(lease);
    Ok(())
}
pub(super) fn native(
    app: &AppHandle,
    binding: MainBinding,
) -> Result<Option<super::double_tap_native::Lease>, String> {
    Ok(runtime(app)?
        .entries
        .lock()
        .iter()
        .find(|entry| entry.binding == binding)
        .and_then(|entry| entry.native))
}
pub(super) fn retire(app: &AppHandle, binding: MainBinding) -> Result<(), String> {
    let runtime = runtime(app)?;
    let entries = runtime.entries.lock();
    if let Some(entry) = entries.iter().find(|entry| entry.binding == binding) {
        if let Some(receipt) = entry.token.receipt.lock().as_ref() { receipt.retire(); }
    }
    Ok(())
}
pub(super) fn remove(app: &AppHandle, binding: MainBinding) -> Result<(), String> {
    let runtime = runtime(app)?;
    let mut entries = runtime.entries.lock();
    if let Some(index) = entries.iter().position(|entry| entry.binding == binding) {
        entries[index].token.publish(0);
        entries[index].token.receipt.lock().take();
        entries.remove(index);
    }
    Ok(())
}
pub(super) fn publish(app: &AppHandle, owner: Option<(MainBinding, u64)>) {
    let Ok(runtime) = runtime(app) else {
        return;
    };
    let closed = runtime.closed.load(Ordering::Acquire);
    for entry in runtime.entries.lock().iter() {
        let generation = owner
            .filter(|(binding, _)| !closed && *binding == entry.binding)
            .map_or(0, |(_, generation)| generation);
        entry.token.publish(generation);
    }
}
pub(super) fn enqueue(app: &AppHandle, token: &Arc<Token>, receipt: Weak<crate::app_global_shortcuts::recording_gate::Receipt>, epoch: u64) {
    enqueue_action(app, token, receipt, false, epoch);
}
pub(super) fn enqueue_double(app: &AppHandle, token: &Arc<Token>, epoch: u64) {
    let receipt = token.receipt.lock().as_ref().map(Arc::downgrade);
    if let Some(receipt) = receipt { enqueue_action(app, token, receipt, true, epoch); }
}
fn enqueue_action(app: &AppHandle, token: &Arc<Token>, receipt: Weak<crate::app_global_shortcuts::recording_gate::Receipt>, double: bool, epoch: u64) {
    let stamp = token.epoch.load(Ordering::Acquire);
    if !token.valid(stamp) { return; }
    let app = app.clone();
    let token = token.clone();
    tauri::async_runtime::spawn(async move {
        let target = app.clone();
        let _ = app.run_on_main_thread(move || {
            if token.valid(stamp) && !is_closed(&target) {
                let Some(receipt) = receipt.upgrade() else { return; };
                let Some(_permit) = receipt.admit(epoch) else { return; };
                drop(receipt);
                if let Err(error) = if double {
                    super::toggle_main_window_from_double_tap(&target)
                } else {
                    super::toggle_main_window(&target)
                } { tracing::error!(%error, "Main shortcut action failed"); }
            }
        });
    });
}
pub(crate) fn quiesce(app: &AppHandle) {
    if let Ok(runtime) = runtime(app) {
        runtime.closed.store(true, Ordering::Release);
        // Exit never blocks behind a worker that may be waiting on the native thread.
        if let Some(entries) = runtime.entries.try_lock() {
            for entry in entries.iter() {
                entry.token.publish(0);
            }
        }
    }
}
pub(super) fn is_closed(app: &AppHandle) -> bool {
    runtime(app).map_or(true, |runtime| runtime.closed.load(Ordering::Acquire))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_receipt_cannot_admit_even_when_old_queue_upgraded_it() {
        let gate = Arc::new(crate::app_global_shortcuts::recording_gate::Gate::default());
        let receipt = gate.receipt(None).unwrap();
        receipt.publish();
        let epoch = receipt.edge(true).unwrap();
        let queued = Arc::downgrade(&receipt);
        let already_upgraded = queued.upgrade().unwrap();
        receipt.retire();
        assert!(already_upgraded.admit(epoch).is_none());
        let replacement = gate.receipt(None).unwrap();
        replacement.publish();
        assert!(already_upgraded.admit(epoch).is_none());
        assert!(replacement.edge(true).is_some());
    }
    #[test]
    fn unpublished_alias_rollback_stop_and_replaced_lease_invalidate_old_actions() {
        let token = Token::default();
        assert!(!token.valid(0));
        token.publish(7);
        let first = token.epoch.load(Ordering::Acquire);
        assert!(token.valid(first));
        token.publish(8);
        assert!(!token.valid(first)); // alias-only generation
        let alias = token.epoch.load(Ordering::Acquire);
        token.publish(0);
        assert!(!token.valid(alias));
        token.publish(8);
        assert!(!token.valid(alias)); // same-generation rollback/retry
        let restored = token.epoch.load(Ordering::Acquire);
        token.invalidate_pending();
        assert!(!token.valid(restored));
        token.publish(0);
        let replacement = Token::default();
        replacement.publish(8);
        assert!(!token.valid(restored));
    }
}
