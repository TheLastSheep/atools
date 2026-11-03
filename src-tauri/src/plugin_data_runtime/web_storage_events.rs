//! Short-lived, bounded private event payloads for localStorage mutations.

use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) const EVENT_NAME: &str = "atools-plugin-web-storage-changed";
const MAX_PER_PLUGIN: usize = 32;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EventTarget {
    pub session_id: String,
    pub window: String,
    pub plugin_id: String,
    pub instance_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EventBody {
    pub client_id: String,
    pub url: String,
    pub key: Option<Vec<u16>>,
    pub old_value: Option<Vec<u16>>,
    pub new_value: Option<Vec<u16>>,
}

#[derive(Default)]
pub(super) struct WebStorageEvents {
    store: Mutex<Store>,
}

#[derive(Default)]
struct Store {
    records: HashMap<String, Arc<Record>>,
    order: VecDeque<String>,
    invocation_ids: HashMap<String, String>,
    bytes: usize,
    evictions: u64,
    emit_mismatches: u64,
}

struct Record {
    id: String,
    plugin_id: String,
    writer_session: String,
    body: Arc<EventBody>,
    targets: Vec<EventTarget>,
    created: Instant,
    bytes: usize,
    invocation_id: Option<String>,
}

impl WebStorageEvents {
    /// Stores a post-mutation candidate. It is unreadable until the TaskRun succeeds.
    pub(super) fn stage(
        &self,
        invocation_id: &str,
        plugin_id: &str,
        writer_session: &str,
        body: EventBody,
        targets: Vec<EventTarget>,
    ) {
        let bytes = body_bytes(plugin_id, writer_session, &body, &targets);
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        if targets.is_empty() {
            return;
        }
        if bytes > MAX_TOTAL_BYTES {
            store.evictions = store.evictions.saturating_add(1);
            return;
        }
        make_room(&mut store, plugin_id, bytes);
        if store.bytes.saturating_add(bytes) > MAX_TOTAL_BYTES
            || store
                .records
                .values()
                .filter(|record| record.plugin_id == plugin_id)
                .count()
                >= MAX_PER_PLUGIN
        {
            store.evictions = store.evictions.saturating_add(1);
            return;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let record = Arc::new(Record {
            id: id.clone(),
            plugin_id: plugin_id.into(),
            writer_session: writer_session.into(),
            body: Arc::new(body),
            targets,
            created: Instant::now(),
            bytes,
            invocation_id: Some(invocation_id.into()),
        });
        store.bytes += bytes;
        store
            .invocation_ids
            .insert(invocation_id.into(), id.clone());
        store.order.push_back(id.clone());
        store.records.insert(id, record);
    }

    /// Makes a staged event visible only after its audited operation has completed.
    pub(super) fn publish(
        &self,
        invocation_id: &str,
        active_sessions: &HashSet<String>,
    ) -> Option<(String, Vec<EventTarget>)> {
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        let id = store.invocation_ids.remove(invocation_id)?;
        let record = store.records.get(&id)?.clone();
        if !active_sessions.contains(&record.writer_session) {
            remove_record(&mut store, &id, false);
            return None;
        }
        let targets = record
            .targets
            .iter()
            .filter(|target| active_sessions.contains(&target.session_id))
            .cloned()
            .collect::<Vec<_>>();
        if targets.is_empty() {
            remove_record(&mut store, &id, false);
            return None;
        }
        let published = Arc::new(Record {
            id: record.id.clone(),
            plugin_id: record.plugin_id.clone(),
            writer_session: record.writer_session.clone(),
            body: record.body.clone(),
            targets: targets.clone(),
            created: record.created,
            bytes: record.bytes,
            invocation_id: None,
        });
        store.records.insert(id.clone(), published);
        Some((id, targets))
    }

    pub(super) fn abandon(&self, invocation_id: &str) {
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        if let Some(id) = store.invocation_ids.remove(invocation_id) {
            remove_record(&mut store, &id, false);
        }
    }

    /// Reads are repeatable, session-scoped, and never consume the event.
    pub(super) fn read(
        &self,
        plugin_id: &str,
        event_id: &str,
        session_id: &str,
        client_id: &str,
    ) -> Option<EventBody> {
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        let record = store.records.get(event_id)?.clone();
        if record.plugin_id != plugin_id
            || record.invocation_id.is_some()
            || !record
                .targets
                .iter()
                .any(|target| target.session_id == session_id)
            || record.body.client_id == client_id
        {
            return None;
        }
        Some((*record.body).clone())
    }

    /// Drops closed, rotated, revoked, and expired generations without polling.
    pub(super) fn prune(&self, active_sessions: &HashSet<String>) {
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        let ids = store
            .records
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let Some(record) = store.records.get(&id).cloned() else {
                continue;
            };
            if !active_sessions.contains(&record.writer_session) {
                remove_record(&mut store, &id, false);
                continue;
            }
            let targets = record
                .targets
                .iter()
                .filter(|target| active_sessions.contains(&target.session_id))
                .cloned()
                .collect::<Vec<_>>();
            if targets.is_empty() {
                remove_record(&mut store, &id, false);
            } else if targets.len() != record.targets.len() {
                store.records.insert(
                    id,
                    Arc::new(Record {
                        id: record.id.clone(),
                        plugin_id: record.plugin_id.clone(),
                        writer_session: record.writer_session.clone(),
                        body: record.body.clone(),
                        targets,
                        created: record.created,
                        bytes: record.bytes,
                        invocation_id: record.invocation_id.clone(),
                    }),
                );
            }
        }
    }

    pub(super) fn emit_mismatch(&self) {
        let mut store = self.store.lock();
        store.emit_mismatches = store.emit_mismatches.saturating_add(1);
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(super) fn counts(&self) -> (usize, usize, u64, u64) {
        let mut store = self.store.lock();
        cleanup_expired(&mut store);
        (
            store.records.len(),
            store.bytes,
            store.evictions,
            store.emit_mismatches,
        )
    }
}

fn body_bytes(
    plugin_id: &str,
    writer_session: &str,
    body: &EventBody,
    targets: &[EventTarget],
) -> usize {
    targets.iter().fold(
        128usize
            .saturating_add(plugin_id.len())
            .saturating_add(writer_session.len())
            .saturating_add(32) // random event id
            .saturating_add(body.client_id.len())
            .saturating_add(body.url.len())
            .saturating_add(
                body.key
                    .as_ref()
                    .map_or(0, |key| key.len().saturating_mul(2)),
            )
            .saturating_add(
                body.old_value
                    .as_ref()
                    .map_or(0, |value| value.len().saturating_mul(2)),
            )
            .saturating_add(
                body.new_value
                    .as_ref()
                    .map_or(0, |value| value.len().saturating_mul(2)),
            ),
        |bytes, target| {
            bytes
                .saturating_add(32)
                .saturating_add(target.session_id.len())
                .saturating_add(target.window.len())
                .saturating_add(target.plugin_id.len())
                .saturating_add(target.instance_id.len())
        },
    )
}

fn make_room(store: &mut Store, plugin_id: &str, incoming: usize) {
    loop {
        let plugin_count = store
            .records
            .values()
            .filter(|record| record.plugin_id == plugin_id)
            .count();
        if store.bytes.saturating_add(incoming) <= MAX_TOTAL_BYTES && plugin_count < MAX_PER_PLUGIN
        {
            break;
        }
        let candidate = store
            .order
            .iter()
            .filter_map(|id| store.records.get(id).map(|record| (id, record)))
            .filter(|(_, record)| {
                store.bytes.saturating_add(incoming) > MAX_TOTAL_BYTES
                    || record.plugin_id == plugin_id
            })
            .min_by_key(|(_, record)| record.created)
            .map(|(id, _)| id.clone());
        let Some(candidate) = candidate else {
            break;
        };
        remove_record(store, &candidate, true);
    }
}

fn cleanup_expired(store: &mut Store) {
    let expired = store
        .records
        .iter()
        .filter(|(_, record)| record.created.elapsed() >= TTL)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in expired {
        remove_record(store, &id, false);
    }
}

fn remove_record(store: &mut Store, id: &str, eviction: bool) {
    if let Some(record) = store.records.remove(id) {
        store.bytes = store.bytes.saturating_sub(record.bytes);
        if let Some(invocation_id) = record.invocation_id.as_ref() {
            store.invocation_ids.remove(invocation_id);
        }
        store.order.retain(|candidate| candidate != id);
        if eviction {
            store.evictions = store.evictions.saturating_add(1);
        }
        if store.records.is_empty() {
            store.records.shrink_to_fit();
            store.order.shrink_to_fit();
            store.invocation_ids.shrink_to_fit();
            store.bytes = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(session_id: &str, instance_id: &str) -> EventTarget {
        EventTarget {
            session_id: session_id.into(),
            window: "main".into(),
            plugin_id: "plugin-a".into(),
            instance_id: instance_id.into(),
        }
    }

    fn body() -> EventBody {
        EventBody {
            client_id: "a1".repeat(16),
            url: "opaque://source".into(),
            key: Some(vec![0xd800]),
            old_value: None,
            new_value: Some(vec![0xdfff]),
        }
    }

    #[test]
    fn events_are_hidden_until_publish_targeted_repeatable_and_writer_excluded() {
        let store = WebStorageEvents::default();
        let targets = vec![
            target("writer-session", "instance-1"),
            target("reader-session", "instance-2"),
        ];
        store.stage("invocation", "plugin-a", "writer-session", body(), targets);
        assert_eq!(store.counts().0, 1);
        assert_eq!(
            store.read("plugin-a", "event", "reader-session", &"b2".repeat(16)),
            None
        );

        let active = HashSet::from(["writer-session".into(), "reader-session".into()]);
        let (event_id, published_targets) = store.publish("invocation", &active).unwrap();
        assert_eq!(event_id.len(), 32);
        assert_eq!(published_targets.len(), 2);
        assert_eq!(
            store.read("plugin-a", &event_id, "writer-session", &("a1".repeat(16))),
            None
        );
        let reader = store
            .read("plugin-a", &event_id, "reader-session", &"b2".repeat(16))
            .unwrap();
        assert_eq!(reader.client_id, "a1".repeat(16));
        assert_eq!(reader.url, "opaque://source");
        assert_eq!(reader.key, Some(vec![0xd800]));
        assert_eq!(
            store.read("plugin-a", &event_id, "reader-session", &"b2".repeat(16)),
            Some(reader)
        );
        assert_eq!(
            store.read("plugin-b", &event_id, "reader-session", &"b2".repeat(16)),
            None
        );
    }

    #[test]
    fn new_sessions_cannot_read_old_events_and_close_prunes_targetless_entries() {
        let store = WebStorageEvents::default();
        store.stage(
            "invocation",
            "plugin-a",
            "writer-session",
            body(),
            vec![
                target("writer-session", "instance-1"),
                target("reader-session", "instance-2"),
            ],
        );
        let active = HashSet::from(["writer-session".into(), "reader-session".into()]);
        let (id, _) = store.publish("invocation", &active).unwrap();
        assert_eq!(
            store.read("plugin-a", &id, "new-session", &"c3".repeat(16)),
            None
        );
        store.prune(&HashSet::new());
        assert_eq!(store.counts().0, 0);
        assert_eq!(store.counts().1, 0);
    }

    #[test]
    fn per_plugin_overflow_evicts_oldest_with_only_a_fixed_counter() {
        let store = WebStorageEvents::default();
        let targets = vec![target("writer-session", "instance-1")];
        for index in 0..=MAX_PER_PLUGIN {
            store.stage(
                &format!("invocation-{index}"),
                "plugin-a",
                "writer-session",
                body(),
                targets.clone(),
            );
        }
        let (count, bytes, evictions, _) = store.counts();
        assert_eq!(count, MAX_PER_PLUGIN);
        assert!(bytes > 0);
        assert_eq!(evictions, 1);
    }

    #[test]
    fn expiry_is_lazy_and_releases_payload_bytes() {
        let store = WebStorageEvents::default();
        store.stage(
            "invocation",
            "plugin-a",
            "writer-session",
            body(),
            vec![target("writer-session", "instance-1")],
        );
        let mut state = store.store.lock();
        let id = state.order.front().unwrap().clone();
        let record = state.records.get(&id).unwrap().clone();
        state.records.insert(
            id.clone(),
            Arc::new(Record {
                id: record.id.clone(),
                plugin_id: record.plugin_id.clone(),
                writer_session: record.writer_session.clone(),
                body: record.body.clone(),
                targets: record.targets.clone(),
                created: Instant::now() - TTL - Duration::from_secs(1),
                bytes: record.bytes,
                invocation_id: record.invocation_id.clone(),
            }),
        );
        drop(state);
        assert_eq!(store.counts().0, 0);
        assert_eq!(store.counts().1, 0);
    }
}
