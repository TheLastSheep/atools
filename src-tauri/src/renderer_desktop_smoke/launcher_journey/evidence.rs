use atools_core::{
    agent::{AuditLogEntry, AuditStatus},
    db::RendererDirectSubtype,
    task_run::{TaskRun, TaskRunInitiatorType, TaskRunStatus},
    Database,
};
use serde_json::Value;

pub(in crate::renderer_desktop_smoke) struct DatabaseEvidence {
    task_runs: Vec<TaskRun>,
    audits: Vec<AuditLogEntry>,
    history: Vec<Value>,
}

impl DatabaseEvidence {
    pub(in crate::renderer_desktop_smoke) fn read(db: &Database) -> Result<Self, ()> {
        let task_runs = db.list_task_runs(32).map_err(|_| ())?;
        let audits = db.list_audit_entries(32).map_err(|_| ())?;
        let snapshot = db.read_renderer_app_state().map_err(|_| ())?;
        let history = match snapshot
            .values
            .get("command-history")
            .and_then(|value| value.as_deref())
        {
            Some(raw) => serde_json::from_str::<Vec<Value>>(raw).map_err(|_| ())?,
            None => Vec::new(),
        };
        Ok(Self {
            task_runs,
            audits,
            history,
        })
    }

    pub(in crate::renderer_desktop_smoke) fn empty(&self) -> bool {
        self.task_runs.is_empty() && self.history.is_empty()
    }

    pub(in crate::renderer_desktop_smoke) fn task_run_count(&self) -> u64 {
        self.task_runs.len() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn denied_run_count(&self, path: &str) -> u64 {
        self.task_runs
            .iter()
            .filter(|run| target_run(run, path) && run.status == TaskRunStatus::Cancelled)
            .count() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn succeeded_run_count(&self, path: &str) -> u64 {
        self.task_runs
            .iter()
            .filter(|run| target_run(run, path) && run.status == TaskRunStatus::Succeeded)
            .count() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn denied_audit(&self, path: &str) -> bool {
        self.task_runs.iter().any(|run| {
            target_run(run, path)
                && run.status == TaskRunStatus::Cancelled
                && run.audit_id.as_deref().is_some_and(|audit_id| {
                    self.audits.iter().any(|entry| {
                        entry.id.as_str() == audit_id
                            && target_audit(entry, path)
                            && entry.status == AuditStatus::Denied
                    })
                })
        })
    }

    pub(in crate::renderer_desktop_smoke) fn succeeded_audit(&self, path: &str) -> bool {
        self.task_runs.iter().any(|run| {
            target_run(run, path)
                && run.status == TaskRunStatus::Succeeded
                && run.audit_id.as_deref().is_some_and(|audit_id| {
                    self.audits.iter().any(|entry| {
                        entry.id.as_str() == audit_id
                            && target_audit(entry, path)
                            && entry.status == AuditStatus::Confirmed
                    })
                })
        })
    }

    pub(in crate::renderer_desktop_smoke) fn denied_audit_count(&self, path: &str) -> u64 {
        self.audits
            .iter()
            .filter(|entry| target_audit(entry, path) && entry.status == AuditStatus::Denied)
            .count() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn confirmed_audit_count(&self, path: &str) -> u64 {
        self.audits
            .iter()
            .filter(|entry| target_audit(entry, path) && entry.status == AuditStatus::Confirmed)
            .count() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn history_count(&self) -> u64 {
        self.history.len() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn matching_history_count(
        &self,
        path: &str,
        name: &str,
    ) -> u64 {
        self.matching_history_count_for_subtype(path, name, RendererDirectSubtype::App)
    }

    pub(in crate::renderer_desktop_smoke) fn matching_history_count_for_subtype(
        &self,
        path: &str,
        name: &str,
        sub_type: RendererDirectSubtype,
    ) -> u64 {
        self.history
            .iter()
            .filter(|record| history_record_matches(record, path, name, sub_type))
            .count() as u64
    }

    pub(in crate::renderer_desktop_smoke) fn matching_history_use_count(
        &self,
        path: &str,
        name: &str,
    ) -> u64 {
        self.matching_history_use_count_for_subtype(path, name, RendererDirectSubtype::App)
    }

    pub(in crate::renderer_desktop_smoke) fn matching_history_use_count_for_subtype(
        &self,
        path: &str,
        name: &str,
        sub_type: RendererDirectSubtype,
    ) -> u64 {
        self.history
            .iter()
            .find(|record| history_record_matches(record, path, name, sub_type))
            .and_then(|record| record.get("useCount"))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    }

    pub(in crate::renderer_desktop_smoke) fn history_count_for_subtype(
        &self,
        sub_type: RendererDirectSubtype,
    ) -> u64 {
        self.history
            .iter()
            .filter(|record| direct_history_subtype_matches(record, sub_type))
            .count() as u64
    }
}

fn history_record_matches(
    record: &Value,
    path: &str,
    name: &str,
    sub_type: RendererDirectSubtype,
) -> bool {
    record.get("path").and_then(Value::as_str) == Some(path)
        && record.get("name").and_then(Value::as_str) == Some(name)
        && direct_history_subtype_matches(record, sub_type)
}

fn direct_history_subtype_matches(record: &Value, sub_type: RendererDirectSubtype) -> bool {
    let expected_sub_type = match sub_type {
        RendererDirectSubtype::App => "app",
        RendererDirectSubtype::LocalShortcut => "local-shortcut",
    };
    record.get("type").and_then(Value::as_str) == Some("direct")
        && record.get("subType").and_then(Value::as_str) == Some(expected_sub_type)
}

fn target_run(run: &TaskRun, path: &str) -> bool {
    run.capability_id == "open_or_reveal_path"
        && run.initiator.kind == TaskRunInitiatorType::Human
        && run.initiator.client_id.as_deref() == Some("atools-ui")
        && run.input.get("path").and_then(Value::as_str) == Some(path)
        && run.input.get("reveal").and_then(Value::as_bool) == Some(false)
}

fn target_audit(entry: &AuditLogEntry, path: &str) -> bool {
    entry.tool_name == "open_or_reveal_path"
        && entry.client_id == "atools-ui"
        && entry.input.get("path").and_then(Value::as_str) == Some(path)
        && entry.input.get("reveal").and_then(Value::as_bool) == Some(false)
}

#[cfg(test)]
mod tests {
    use super::{DatabaseEvidence, RendererDirectSubtype};
    use atools_core::{
        agent::{AuditLogEntry, AuditStatus},
        task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
        Database,
    };
    use serde_json::json;

    #[test]
    fn mismatched_denied_audit_id_does_not_pair_with_task_run() {
        let db = Database::in_memory().unwrap();
        let path = "/owned/AToolsOwnedProbeFirst.app";
        let mut run = TaskRun::new(
            "open_or_reveal_path",
            TaskRunInitiator::human(Some("atools-ui".to_owned())),
            json!({ "path": path, "reveal": false }),
        );
        run.transition(TaskRunStatus::Cancelled).unwrap();
        run.audit_id = Some("audit-for-a-different-run".to_owned());
        db.upsert_task_run(&run).unwrap();

        let mut audit = AuditLogEntry::new(
            "atools-ui",
            "open_or_reveal_path",
            json!({ "path": path, "reveal": false }),
            AuditStatus::Denied,
        );
        audit.id = "unlinked-denied-audit".to_owned();
        db.insert_audit_entry(&audit).unwrap();

        let evidence = DatabaseEvidence::read(&db).unwrap();
        assert_eq!(evidence.denied_run_count(path), 1);
        assert_eq!(evidence.denied_audit_count(path), 1);
        assert!(!evidence.denied_audit(path));
    }

    #[test]
    fn mismatched_succeeded_audit_id_does_not_pair_with_task_run() {
        let db = Database::in_memory().unwrap();
        let path = "/owned/AToolsOwnedProbeFirst.app";
        let mut run = TaskRun::new(
            "open_or_reveal_path",
            TaskRunInitiator::human(Some("atools-ui".to_owned())),
            json!({ "path": path, "reveal": false }),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        run.audit_id = Some("audit-for-a-different-run".to_owned());
        db.upsert_task_run(&run).unwrap();

        let mut audit = AuditLogEntry::new(
            "atools-ui",
            "open_or_reveal_path",
            json!({ "path": path, "reveal": false }),
            AuditStatus::Confirmed,
        );
        audit.id = "unlinked-confirmed-audit".to_owned();
        db.insert_audit_entry(&audit).unwrap();

        let evidence = DatabaseEvidence::read(&db).unwrap();
        assert_eq!(evidence.succeeded_run_count(path), 1);
        assert_eq!(evidence.confirmed_audit_count(path), 1);
        assert!(!evidence.succeeded_audit(path));
    }

    #[test]
    fn local_shortcut_history_counts_do_not_mix_with_direct_apps() {
        let db = Database::in_memory().unwrap();
        let path = "/owned/same-target";
        let name = "Same target";
        let history = json!([
            { "type": "direct", "subType": "app", "path": path, "name": name, "useCount": 3 },
            { "type": "direct", "subType": "local-shortcut", "path": path, "name": name, "useCount": 9 },
            { "type": "direct", "subType": "future-kind", "path": "/owned/future", "name": "Future", "useCount": 4 },
            { "type": "plugin", "subType": "app", "path": "/owned/plugin", "name": "Plugin", "useCount": 5 },
            { "type": "app", "subType": "app", "path": "/owned/legacy", "name": "Legacy", "useCount": 6 }
        ]);
        db.set_setting(
            "ztools-renderer:command-history",
            &serde_json::to_string(&history).unwrap(),
        )
        .unwrap();

        let evidence = DatabaseEvidence::read(&db).unwrap();
        assert_eq!(
            evidence.matching_history_count_for_subtype(path, name, RendererDirectSubtype::App),
            1
        );
        assert_eq!(
            evidence.matching_history_count_for_subtype(
                path,
                name,
                RendererDirectSubtype::LocalShortcut
            ),
            1
        );
        assert_eq!(
            evidence.matching_history_use_count_for_subtype(path, name, RendererDirectSubtype::App),
            3
        );
        assert_eq!(
            evidence.matching_history_use_count_for_subtype(
                path,
                name,
                RendererDirectSubtype::LocalShortcut
            ),
            9
        );
        assert_eq!(
            evidence.history_count_for_subtype(RendererDirectSubtype::App),
            1
        );
        assert_eq!(
            evidence.history_count_for_subtype(RendererDirectSubtype::LocalShortcut),
            1
        );

        assert_eq!(evidence.matching_history_count(path, name), 1);
        assert_eq!(evidence.matching_history_use_count(path, name), 3);
    }
}
