use super::*;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64};
pub(super) const STAGES: &[&str] = &[
    "main-ready",
    "about-ready",
    "about-manual",
    "popup-ready",
    "auto-on",
    "auto-off",
    "settings-closed",
    "about-reopened",
    "settings-final-closed",
    "popup-disposed",
    "main-disposed",
];
#[derive(Clone)]
pub(super) struct Child {
    pub id: String,
    pub label: String,
    pub view: tauri::Webview,
}
#[derive(Default)]
pub(in crate::renderer_desktop_smoke::updater_journey) struct State {
    rows: Mutex<Vec<Value>>,
    pub children: Mutex<Vec<Child>>,
    pub injections: Mutex<BTreeSet<String>>,
    pub popup_label: Mutex<Option<String>>,
    pub baseline: Mutex<Option<Value>>,
    pub closed: AtomicU64,
    pub stale_rejected: AtomicBool,
}
impl State {
    pub fn expect_stage(&self, stage: &str) -> Result<(), String> {
        if STAGES.get(self.rows.lock().len()) != Some(&stage) {
            return Err("about-stage-order-rejected".into());
        }
        Ok(())
    }
    pub fn accept(&self, row: Value, h: &Harness) -> Result<(), String> {
        let mut rows = self.rows.lock();
        let stage = row["stage"].as_str().ok_or("about-stage-invalid")?;
        if STAGES.get(rows.len()) != Some(&stage) {
            return Err("about-stage-order-rejected".into());
        }
        rows.push(row);
        drop(rows);
        h.changed.notify_waiters();
        Ok(())
    }
    pub fn rows(&self) -> Vec<Value> {
        self.rows.lock().clone()
    }
    pub fn get(&self, stage: &str) -> Option<Value> {
        self.rows
            .lock()
            .iter()
            .find(|r| r["stage"] == stage)
            .cloned()
    }
    pub fn child(&self) -> Result<Child, String> {
        self.children
            .lock()
            .last()
            .cloned()
            .ok_or_else(|| "about-child-missing".into())
    }
    pub fn bind(&self, view: &tauri::Webview) -> Result<(), String> {
        let id = view
            .label()
            .strip_prefix("ztools-settings-")
            .ok_or("about-child-source-rejected")?;
        let mut children = self.children.lock();
        if children.iter().any(|c| c.id == id) {
            return Ok(());
        }
        if children.len() >= 2 {
            return Err("about-child-generation-limit".into());
        }
        children.push(Child {
            id: id.into(),
            label: view.label().into(),
            view: view.clone(),
        });
        Ok(())
    }
}
