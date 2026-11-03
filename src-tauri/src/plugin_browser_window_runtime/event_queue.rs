//! Coalesces active native events without a permanent timer or per-event task.
use super::{intents::WindowLife, lifecycle::validate_alive_window, EVENT};
use parking_lot::Mutex;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

const MAX_SNAPSHOTS: usize = 16;
const ACTIVE_INTERVAL: Duration = Duration::from_millis(32);
const KINDS: [&str; 4] = ["Moved", "Resized", "Focused", "ScaleFactorChanged"];

#[derive(Default)]
struct Slot {
    pending: Mutex<u8>,
}

#[derive(Default)]
struct EventQueue {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

impl EventQueue {
    /// Only the first event schedules work; later events merge into its slot.
    fn enqueue(&self, label: &str, kind: &str) -> Option<Arc<Slot>> {
        let bit = 1 << KINDS.iter().position(|candidate| *candidate == kind)?;
        let mut slots = self.slots.lock();
        if let Some(slot) = slots.get(label) {
            *slot.pending.lock() |= bit;
            return None;
        }
        if slots.len() >= MAX_SNAPSHOTS {
            return None;
        }
        let slot = Arc::new(Slot {
            pending: Mutex::new(bit),
        });
        slots.insert(label.to_string(), slot.clone());
        Some(slot)
    }

    fn take(&self, slot: &Slot) -> Vec<&'static str> {
        let flags = std::mem::take(&mut *slot.pending.lock());
        KINDS
            .iter()
            .enumerate()
            .filter_map(|(index, kind)| (flags & (1 << index) != 0).then_some(*kind))
            .collect()
    }

    /// Check and remove under the enqueue lock, so an arriving event is either
    /// picked up by this worker or starts its own worker after removal.
    fn finish(&self, label: &str, slot: &Arc<Slot>) -> bool {
        let mut slots = self.slots.lock();
        if !slots
            .get(label)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            return false;
        }
        if *slot.pending.lock() != 0 {
            return true;
        }
        slots.remove(label);
        false
    }

    fn remove(&self, label: &str, slot: &Arc<Slot>) {
        let mut slots = self.slots.lock();
        if slots
            .get(label)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            slots.remove(label);
        }
    }

    /// Retry a failed read only when a newer event arrived while it ran. Keep
    /// the failed batch's kinds, without starting a permanent error retry loop.
    fn retry_pending(&self, label: &str, slot: &Arc<Slot>, failed: &[&str]) -> bool {
        let mut slots = self.slots.lock();
        if !slots
            .get(label)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            return false;
        }
        let mut pending = slot.pending.lock();
        if *pending == 0 {
            slots.remove(label);
            return false;
        }
        for kind in failed {
            if let Some(index) = KINDS.iter().position(|candidate| candidate == kind) {
                *pending |= 1 << index;
            }
        }
        true
    }
}

struct SlotGuard {
    queue: Arc<EventQueue>,
    label: String,
    slot: Arc<Slot>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.queue.remove(&self.label, &self.slot);
    }
}

pub(super) fn queue_native_event(app: &AppHandle, label: &str, kind: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some(window) = runtime.window(label) else {
        return;
    };
    if *window.life.lock() != WindowLife::Alive {
        return;
    }
    if app.try_state::<Arc<EventQueue>>().is_none() {
        app.manage(Arc::new(EventQueue::default()));
    }
    let queue = app.state::<Arc<EventQueue>>().inner().clone();
    let Some(slot) = queue.enqueue(label, kind) else {
        return;
    };
    let app = app.clone();
    let guard = SlotGuard {
        queue,
        label: label.to_string(),
        slot,
    };
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ACTIVE_INTERVAL).await;
            let kinds = guard.queue.take(&guard.slot);
            let Ok(runtime) = super::manager(&app) else {
                break;
            };
            if !runtime
                .window(&window.native_label)
                .is_some_and(|current| Arc::ptr_eq(&current, &window))
                || *window.life.lock() != WindowLife::Alive
                || validate_alive_window(&app, &window).is_err()
            {
                break;
            }
            let snapshot =
                match crate::plugin_browser_window_native::snapshot(&app, &window.native_label)
                    .await
                {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        if guard.queue.retry_pending(&guard.label, &guard.slot, &kinds) {
                            continue;
                        }
                        break;
                    }
                };
            if !runtime
                .window(&window.native_label)
                .is_some_and(|current| Arc::ptr_eq(&current, &window))
                || *window.life.lock() != WindowLife::Alive
                || validate_alive_window(&app, &window).is_err()
            {
                break;
            }
            let payload = json!({
                "windowId": window.frontend_window_id,
                "nativeLabel": window.native_label,
                "kind": "NativeStateChanged",
                "kinds": kinds,
                "snapshot": snapshot,
            });
            let _ = app.emit_to(window.parent_label.clone(), EVENT, payload);
            if !guard.queue.finish(&guard.label, &guard.slot) {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_burst_has_one_worker_and_keeps_each_changed_kind() {
        let queue = EventQueue::default();
        let slot = queue.enqueue("one", "Moved").unwrap();
        for _ in 0..10_000 {
            for kind in KINDS {
                assert!(queue.enqueue("one", kind).is_none());
            }
        }
        assert_eq!(queue.slots.lock().len(), 1);
        assert_eq!(queue.take(&slot), KINDS);
        assert!(!queue.finish("one", &slot));
        assert!(queue.slots.lock().is_empty());
    }

    #[test]
    fn event_during_snapshot_is_observed_by_same_worker_or_next_worker() {
        let queue = EventQueue::default();
        let slot = queue.enqueue("one", "Moved").unwrap();
        assert_eq!(queue.take(&slot), ["Moved"]);
        assert!(queue.enqueue("one", "Focused").is_none());
        assert!(queue.finish("one", &slot));
        assert_eq!(queue.take(&slot), ["Focused"]);
        assert!(!queue.finish("one", &slot));
        let replacement = queue.enqueue("one", "Resized").unwrap();
        queue.remove("one", &slot);
        assert_eq!(queue.take(&replacement), ["Resized"]);
        assert!(!queue.finish("one", &replacement));
    }

    #[test]
    fn stalled_snapshots_are_bounded_and_release_capacity_on_drop() {
        let queue = Arc::new(EventQueue::default());
        let mut guards = Vec::new();
        for index in 0..MAX_SNAPSHOTS {
            let label = index.to_string();
            let slot = queue.enqueue(&label, "Moved").unwrap();
            guards.push(SlotGuard {
                queue: queue.clone(),
                label,
                slot,
            });
        }
        assert!(queue.enqueue("overflow", "Moved").is_none());
        assert!(queue.enqueue("0", "Resized").is_none());
        assert!(queue.enqueue("unknown", "unsupported").is_none());
        drop(guards.pop());
        assert!(queue.enqueue("new", "Moved").is_some());
        drop(guards);
        assert_eq!(queue.slots.lock().len(), 1);
    }

    #[test]
    fn failed_snapshot_preserves_new_events_without_retrying_an_idle_failure() {
        let queue = EventQueue::default();
        let slot = queue.enqueue("one", "Moved").unwrap();
        let failed = queue.take(&slot);
        assert!(queue.enqueue("one", "Focused").is_none());
        assert!(queue.retry_pending("one", &slot, &failed));
        assert_eq!(queue.take(&slot), ["Moved", "Focused"]);
        assert!(!queue.retry_pending("one", &slot, &["Moved", "Focused"]));
        let next = queue.enqueue("one", "Resized").unwrap();
        queue.remove("one", &slot);
        assert_eq!(queue.take(&next), ["Resized"]);
    }
}
