//! Closing stops future reads and cancels private pending work without replay.
use super::sessions::*;
use crate::plugin_page_runtime::DocumentBinding;
use std::{collections::HashSet, sync::atomic::Ordering};
impl Sessions {
    pub async fn close(
        &self,
        owner: Option<&str>,
        plugin: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        self.close_inner(owner, plugin, stop, None).await
    }
    pub async fn close_document_owner(
        &self,
        owner: &str,
        plugin: &str,
        page_id: &str,
    ) -> Vec<String> {
        // Native document revocation prevents late opens without a whole-owner
        // tombstone or a successor walk into a different document.
        self.close_inner(Some(owner), Some(plugin), false, Some(page_id))
            .await
    }
    async fn close_inner(
        &self,
        owner: Option<&str>,
        plugin: Option<&str>,
        stop: bool,
        page_id: Option<&str>,
    ) -> Vec<String> {
        let (sessions, runs) = {
            let mut state = self.store.lock();
            state.stopped |= stop;
            let mut owners = Vec::new();
            if let Some(owner) = owner {
                owners.push(owner.to_string());
                if page_id.is_none() {
                    while let Some(next) =
                        owners.last().and_then(|o| state.successors.get(o)).cloned()
                    {
                        if owners.contains(&next) || owners.len() > MAX_SUCCESSOR_LINKS {
                            break;
                        }
                        owners.push(next);
                    }
                    let protected: HashSet<_> = owners.iter().cloned().collect();
                    // A rotated source remains permanently non-reusable while
                    // its successor edge is retained. Only the terminal owner
                    // needs a separate tombstone for this close operation.
                    let terminal_owners: Vec<_> = owners
                        .iter()
                        .filter(|candidate| !state.successors.contains_key(*candidate))
                        .cloned()
                        .collect();
                    for closed_owner in terminal_owners {
                        if !remember_closed(&mut state, &closed_owner, &protected) {
                            if state.successors.len() < MAX_SUCCESSOR_LINKS {
                                // The bounded edge table can carry a compact
                                // self-tombstone when all timestamp slots are
                                // occupied by unrelated, still-live tombstones.
                                state.successors.insert(closed_owner.clone(), closed_owner);
                            } else {
                                // At both hard limits, fail closed for future
                                // display sessions rather than permit reuse.
                                state.stopped = true;
                            }
                        }
                    }
                }
            }
            let matches = |o: &str, p: &str, d: &Option<DocumentBinding>| {
                (owner.is_none() || owners.iter().any(|v| v == o))
                    && plugin.is_none_or(|v| v == p)
                    && page_id.is_none_or(|id| d.as_ref().is_some_and(|d| d.id() == id))
            };
            let mut runs = Vec::new();
            state.intents.retain(|_, i| {
                if !matches(&i.owner, &i.plugin, &i.document) {
                    return true;
                }
                i.cancelled.store(true, Ordering::Release);
                if let Some(run) = i.run.lock().clone() {
                    runs.push(run);
                }
                false
            });
            let ids: Vec<_> = state
                .sessions
                .values()
                .filter(|s| matches(&s.owner, &s.plugin, &s.document))
                .map(|s| s.id.clone())
                .collect();
            let sessions: Vec<_> = ids
                .iter()
                .filter_map(|id| state.sessions.remove(id))
                .collect();
            for session in &sessions {
                if let Some(run) = session.opener_run.lock().clone() {
                    runs.push(run);
                }
            }
            for invocation in state
                .invocations
                .values()
                .filter(|i| ids.contains(&i.session))
            {
                if let Some(run) = invocation.run.lock().clone() {
                    runs.push(run);
                }
            }
            runs.sort_unstable();
            runs.dedup();
            (sessions, runs)
        };
        for session in sessions {
            *session.active.lock() = false;
        }
        self.idle().await;
        runs
    }
}
