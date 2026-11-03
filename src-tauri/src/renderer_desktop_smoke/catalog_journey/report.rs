use crate::renderer_desktop_smoke::profile::Profile;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const SCOPE: &str = "hidden-original-vue-real-catalog-events";
pub(super) const QUERY: &str = "ATools Catalog";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IconObservation {
    pub(super) complete: bool,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) analysis_succeeded: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventSourceObservation {
    pub(super) subscribers: u64,
    pub(super) listener_state: ListenerState,
    pub(super) delivered_events: u64,
    pub(super) registration_errors: u64,
    pub(super) callback_errors: u64,
    pub(super) registrations_pending: u64,
    pub(super) cleanup_pending: u64,
    pub(super) cleanup_errors: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventSources {
    pub(super) focus_events: EventSourceObservation,
    pub(super) app_state: EventSourceObservation,
    pub(super) context_menu: EventSourceObservation,
    pub(super) app_catalog: EventSourceObservation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SettingsViewObservation {
    pub(super) listener_state: ListenerState,
    pub(super) registration_errors: u64,
    pub(super) cleanup_errors: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DomObservation {
    pub(super) input_found: bool,
    pub(super) input_value: String,
    pub(super) titles: Vec<String>,
    pub(super) document_visibility: String,
    pub(super) document_has_focus: bool,
    pub(super) app_list_calls: u64,
    pub(super) catalog_delivered_events: u64,
    pub(super) catalog_subscriber_count: u64,
    pub(super) pending_native_calls: u64,
    pub(super) app_read_pending: bool,
    pub(super) disposed: bool,
    pub(super) icon: Option<IconObservation>,
    pub(super) event_sources: EventSources,
    pub(super) settings_view: SettingsViewObservation,
    pub(super) native_catalog_events: u64,
    pub(super) witness_stopped: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeObservation {
    pub(super) visible: Option<bool>,
    pub(super) focused: Option<bool>,
    pub(super) focus_gained_events: u64,
    pub(super) active_child_layouts: Option<u64>,
    pub(super) child_webviews: Option<u64>,
    pub(super) data_store_persistent: Option<bool>,
    pub(super) catalog_items: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageObservation {
    pub(super) stage: &'static str,
    pub(super) elapsed_ms: u64,
    pub(super) dom: DomObservation,
    pub(super) native: NativeObservation,
    pub(super) errors: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    owned_fixture: bool,
    root_count: u64,
    window_policy: &'static str,
    data_store_persistent: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardReport {
    reads: Option<u64>,
    writes: Option<u64>,
    pastes: Option<u64>,
}

impl ClipboardReport {
    fn verified_clear(&self) -> bool {
        self.reads == Some(0) && self.writes == Some(0) && self.pastes == Some(0)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StaleLaunchReport {
    rejected: bool,
    task_runs_before: u64,
    task_runs_after: u64,
    history_before: u64,
    history_after: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportBody {
    schema_version: u8,
    journey: &'static str,
    scope: &'static str,
    identifier: String,
    root: String,
    pid: u32,
    auto_clear: &'static str,
    passed: bool,
    metadata: Metadata,
    clipboard: ClipboardReport,
    stale_launch: StaleLaunchReport,
    errors: Vec<&'static str>,
    stages: Vec<StageObservation>,
}

pub(super) struct CatalogReport(ReportBody);

impl CatalogReport {
    pub(super) fn new(profile: &Profile, task_runs_before: u64, history_before: u64) -> Self {
        Self(ReportBody {
            schema_version: 1,
            journey: "catalog",
            scope: SCOPE,
            identifier: profile.identifier.clone(),
            root: profile.root.to_string_lossy().into_owned(),
            pid: std::process::id(),
            auto_clear: "never",
            passed: false,
            metadata: Metadata {
                owned_fixture: true,
                root_count: 1,
                window_policy: "hidden-no-foreground",
                data_store_persistent: None,
            },
            clipboard: ClipboardReport {
                reads: None,
                writes: None,
                pastes: None,
            },
            stale_launch: StaleLaunchReport {
                rejected: false,
                task_runs_before,
                task_runs_after: task_runs_before,
                history_before,
                history_after: history_before,
            },
            errors: Vec::new(),
            stages: Vec::new(),
        })
    }

    pub(super) fn set_data_store_persistent(&mut self, value: Option<bool>) {
        self.0.metadata.data_store_persistent = value;
    }

    pub(super) fn set_stale_launch(
        &mut self,
        rejected: bool,
        task_runs_after: u64,
        history_after: u64,
    ) {
        self.0.stale_launch.rejected = rejected;
        self.0.stale_launch.task_runs_after = task_runs_after;
        self.0.stale_launch.history_after = history_after;
    }

    pub(super) fn set_clipboard_counts(&mut self, counts: Option<(u64, u64, u64)>) {
        let (reads, writes, pastes) = counts
            .map(|(reads, writes, pastes)| (Some(reads), Some(writes), Some(pastes)))
            .unwrap_or((None, None, None));
        self.0.clipboard = ClipboardReport {
            reads,
            writes,
            pastes,
        };
    }

    pub(super) fn push_stage(&mut self, stage: StageObservation) {
        self.0.stages.push(stage);
    }

    pub(super) fn stages(&self) -> &[StageObservation] {
        &self.0.stages
    }

    pub(super) fn add_error(&mut self, error: &'static str) {
        if !self.0.errors.contains(&error) {
            self.0.errors.push(error);
        }
    }

    pub(super) fn to_value(&mut self) -> Value {
        self.0.passed = self.complete();
        serde_json::to_value(&self.0).unwrap_or(Value::Null)
    }

    fn complete(&self) -> bool {
        if !self.0.errors.is_empty()
            || self.0.metadata.data_store_persistent != Some(false)
            || !self.0.clipboard.verified_clear()
            || !self.0.stale_launch.rejected
            || self.0.stale_launch.task_runs_before != 0
            || self.0.stale_launch.task_runs_after != 0
            || self.0.stale_launch.history_before != 0
            || self.0.stale_launch.history_after != 0
            || self.0.stages.len() != Stage::ALL.len()
        {
            return false;
        }
        Stage::ALL.iter().enumerate().all(|(index, expected)| {
            self.0.stages.get(index).is_some_and(|item| {
                item.stage == expected.as_str()
                    && item.errors.is_empty()
                    && item.elapsed_ms <= 120_000
                    && item.dom.valid_for(*expected, index, &self.0.stages)
                    && item.native.valid_for(*expected)
            })
        })
    }
}

#[cfg(test)]
mod clipboard_tests {
    use super::ClipboardReport;

    #[test]
    fn missing_clipboard_counts_are_not_treated_as_zero() {
        let counts = ClipboardReport {
            reads: None,
            writes: None,
            pastes: None,
        };
        assert!(!counts.verified_clear());
    }

    #[test]
    fn any_clipboard_activity_rejects_the_clear_gate() {
        for counts in [
            ClipboardReport {
                reads: Some(1),
                writes: Some(0),
                pastes: Some(0),
            },
            ClipboardReport {
                reads: Some(0),
                writes: Some(1),
                pastes: Some(0),
            },
            ClipboardReport {
                reads: Some(0),
                writes: Some(0),
                pastes: Some(1),
            },
        ] {
            assert!(!counts.verified_clear());
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ListenerState {
    Idle,
    Registering,
    Listening,
    Failed,
    Disposed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Stage {
    Initial,
    Added,
    Removed,
    Disposed,
    PostDispose,
}

impl Stage {
    pub(super) const ALL: [Self; 5] = [
        Self::Initial,
        Self::Added,
        Self::Removed,
        Self::Disposed,
        Self::PostDispose,
    ];

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Added => "added",
            Self::Removed => "removed",
            Self::Disposed => "disposed",
            Self::PostDispose => "post-dispose",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|stage| stage.as_str() == value)
    }
}

impl DomObservation {
    pub(super) fn valid_for(
        &self,
        stage: Stage,
        index: usize,
        previous: &[StageObservation],
    ) -> bool {
        let expected_titles: &[&str] = match stage {
            Stage::Initial | Stage::Removed | Stage::Disposed | Stage::PostDispose => {
                &["ATools Catalog Initial"]
            }
            Stage::Added => &["ATools Catalog Added", "ATools Catalog Initial"],
        };
        let titles = self.titles.iter().map(String::as_str).collect::<Vec<_>>();
        let source_values = [
            &self.event_sources.focus_events,
            &self.event_sources.app_state,
            &self.event_sources.context_menu,
            &self.event_sources.app_catalog,
        ];
        let disposed = matches!(stage, Stage::Disposed | Stage::PostDispose);
        let icon_valid = match stage {
            Stage::Initial | Stage::Added => self.icon.as_ref().is_some_and(|icon| {
                icon.complete && icon.width == 64 && icon.height == 64 && icon.analysis_succeeded
            }),
            Stage::Disposed | Stage::PostDispose => self.icon.is_none(),
            Stage::Removed => self.icon.is_none(),
        };
        if !self.input_found
            || self.input_value != QUERY
            || titles != expected_titles
            || self.document_visibility != "hidden"
            || self.document_has_focus
            || self.pending_native_calls != 0
            || self.app_read_pending
            || self.disposed != disposed
            || self.witness_stopped != (stage == Stage::PostDispose)
            || !icon_valid
            || self.settings_view.registration_errors != 0
            || self.settings_view.cleanup_errors != 0
        {
            return false;
        }
        if disposed {
            if self.catalog_subscriber_count != 0
                || source_values.iter().any(|source| {
                    source.listener_state != ListenerState::Disposed
                        || source.subscribers != 0
                        || source.registrations_pending != 0
                        || source.cleanup_pending != 0
                        || source.registration_errors != 0
                        || source.callback_errors != 0
                        || source.cleanup_errors != 0
                })
                || self.settings_view.listener_state != ListenerState::Disposed
            {
                return false;
            }
        } else if self.app_catalog_listener_ready() {
            if self.catalog_subscriber_count < 2 {
                return false;
            }
        } else {
            return false;
        }

        let Some(prior) = index.checked_sub(1).and_then(|prior| previous.get(prior)) else {
            return stage == Stage::Initial && self.app_list_calls > 0;
        };
        match stage {
            Stage::Added | Stage::Removed => {
                self.app_list_calls > prior.dom.app_list_calls
                    && self.catalog_delivered_events > prior.dom.catalog_delivered_events
                    && self.native_catalog_events > prior.dom.native_catalog_events
            }
            Stage::Disposed => {
                self.app_list_calls >= prior.dom.app_list_calls
                    && self.catalog_delivered_events >= prior.dom.catalog_delivered_events
                    && self.native_catalog_events >= prior.dom.native_catalog_events
            }
            Stage::PostDispose => {
                self.app_list_calls == prior.dom.app_list_calls
                    && self.catalog_delivered_events == prior.dom.catalog_delivered_events
                    && self.native_catalog_events > prior.dom.native_catalog_events
            }
            Stage::Initial => false,
        }
    }

    fn app_catalog_listener_ready(&self) -> bool {
        self.event_sources.app_catalog.listener_state == ListenerState::Listening
            && self.event_sources.app_catalog.registration_errors == 0
            && self.event_sources.app_catalog.callback_errors == 0
            && self.event_sources.app_catalog.registrations_pending == 0
            && self.event_sources.app_catalog.cleanup_errors == 0
    }
}

impl NativeObservation {
    pub(super) fn valid_for(&self, stage: Stage) -> bool {
        let catalog_items = match stage {
            Stage::Initial | Stage::Removed | Stage::Disposed => Some(1),
            Stage::Added | Stage::PostDispose => Some(2),
        };
        self.visible == Some(false)
            && self.focused == Some(false)
            && self.focus_gained_events == 0
            && self.active_child_layouts == Some(0)
            && self.child_webviews == Some(0)
            && self.data_store_persistent == Some(false)
            && self.catalog_items == catalog_items
    }
}
