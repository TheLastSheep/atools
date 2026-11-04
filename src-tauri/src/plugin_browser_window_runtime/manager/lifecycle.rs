//! Terminal intent cleanup and native-window shutdown selection.
use super::super::intents::{Intent, NativeWindow, Reservation, WindowLife};
use super::super::manager::Runtime;
#[cfg(test)]
use crate::plugin_asset_protocol::Owner;
use std::{
    collections::HashSet,
    sync::{atomic::Ordering, Arc},
};

impl Runtime {
    pub fn close_sources(
        &self,
        ids: &[String],
    ) -> (Vec<Arc<Intent>>, Vec<Arc<NativeWindow>>, Vec<Reservation>) {
        let ids: HashSet<_> = ids.iter().map(String::as_str).collect();
        let mut store = self.store.lock();
        // A source closing its own child iframe only invalidates that document's
        // pending work. Ordinary iframe navigation must preserve the native top.
        let windows = store
            .windows
            .values()
            .filter(|window| ids.contains(window.creator_binding_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let target_keys = windows
            .iter()
            .map(|window| (window.owner.clone(), window.frontend_window_id.clone()))
            .collect::<HashSet<_>>();
        let mut intents = Vec::new();
        let mut remove_ids = Vec::new();
        for (id, intent) in &store.intents {
            let directly_revoked = ids.contains(intent.source_binding_id.as_str());
            let targets_closed_window =
                target_keys.contains(&(intent.owner.clone(), intent.window_id.clone()));
            if (directly_revoked || targets_closed_window)
                && !Runtime::is_expected_close(&store, intent)
            {
                if intent.cancel("Plugin source was revoked") {
                    intents.push(intent.clone());
                }
                remove_ids.push(id.clone());
            }
        }
        for id in remove_ids {
            store.intents.remove(&id);
        }
        let reservation_urls = store
            .reservations
            .iter()
            .filter(|(_, reservation)| ids.contains(reservation.binding_id.as_str()))
            .map(|(url, _)| url.clone())
            .collect::<Vec<_>>();
        let reservations = reservation_urls
            .into_iter()
            .filter_map(|url| store.reservations.remove(&url))
            .collect();
        for window in &windows {
            mark_destroying(window);
        }
        (intents, windows, reservations)
    }

    #[cfg(test)]
    pub fn close_owner(
        &self,
        owner: &Owner,
    ) -> (Vec<Arc<Intent>>, Vec<Arc<NativeWindow>>, Vec<Reservation>) {
        let mut store = self.store.lock();
        let mut intents = Vec::new();
        let mut remove_ids = Vec::new();
        for (id, intent) in &store.intents {
            if &intent.owner == owner && !Runtime::is_expected_close(&store, intent) {
                if intent.cancel("Plugin BrowserWindows were closed") {
                    intents.push(intent.clone());
                }
                remove_ids.push(id.clone());
            }
        }
        for id in remove_ids {
            store.intents.remove(&id);
        }
        let reservation_urls = store
            .reservations
            .iter()
            .filter(|(_, reservation)| &reservation.window.owner == owner)
            .map(|(url, _)| url.clone())
            .collect::<Vec<_>>();
        let reservations = reservation_urls
            .into_iter()
            .filter_map(|url| store.reservations.remove(&url))
            .collect();
        let windows = store
            .windows
            .values()
            .filter(|window| &window.owner == owner)
            .cloned()
            .collect::<Vec<_>>();
        for window in &windows {
            mark_destroying(window);
        }
        (intents, windows, reservations)
    }

    pub fn close_parent(
        &self,
        label: &str,
    ) -> (Vec<Arc<Intent>>, Vec<Arc<NativeWindow>>, Vec<Reservation>) {
        let mut store = self.store.lock();
        let mut intents = Vec::new();
        let mut remove_ids = Vec::new();
        for (id, intent) in &store.intents {
            if intent.owner.window == label && !Runtime::is_expected_close(&store, intent) {
                if intent.cancel("Native BrowserWindow parent was destroyed") {
                    intents.push(intent.clone());
                }
                remove_ids.push(id.clone());
            }
        }
        for id in remove_ids {
            store.intents.remove(&id);
        }
        let reservation_urls = store
            .reservations
            .iter()
            .filter(|(_, reservation)| reservation.parent_label == label)
            .map(|(url, _)| url.clone())
            .collect::<Vec<_>>();
        let reservations = reservation_urls
            .into_iter()
            .filter_map(|url| store.reservations.remove(&url))
            .collect();
        let windows = store
            .windows
            .values()
            .filter(|window| window.parent_label == label)
            .cloned()
            .collect::<Vec<_>>();
        for window in &windows {
            mark_destroying(window);
        }
        (intents, windows, reservations)
    }

    pub fn stop(&self) -> (Vec<Arc<Intent>>, Vec<Arc<NativeWindow>>, Vec<Reservation>) {
        self.stopped.store(true, Ordering::Release);
        let mut store = self.store.lock();
        let mut intents = Vec::new();
        let mut remove_ids = Vec::new();
        for (id, intent) in &store.intents {
            if !Runtime::is_expected_close(&store, intent) {
                if intent.cancel("Native BrowserWindow runtime stopped") {
                    intents.push(intent.clone());
                }
                remove_ids.push(id.clone());
            }
        }
        for id in remove_ids {
            store.intents.remove(&id);
        }
        let reservations = store
            .reservations
            .drain()
            .map(|(_, reservation)| reservation)
            .collect();
        let windows = store.windows.values().cloned().collect::<Vec<_>>();
        for window in &windows {
            mark_destroying(window);
        }
        (intents, windows, reservations)
    }
}

fn mark_destroying(window: &Arc<NativeWindow>) -> bool {
    let mut life = window.life.lock();
    if *life == WindowLife::Destroying {
        false
    } else {
        *life = WindowLife::Destroying;
        true
    }
}
