//! Bounded receipt-only view of app startup invokes in the hidden fixture.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::ipc::Invoke;
use tauri::Wry;

const STARTUP_COMMANDS: [&str; 20] = [
    "activate_file_content_feature",
    "expand_window",
    "prepare_plugin_page",
    "claim_plugin_page",
    "prepare_plugin_resources",
    "prepare_plugin_data",
    "get_plugin_data_session",
    "prepare_plugin_paths",
    "get_plugin_path_snapshot",
    "prepare_plugin_dialogs",
    "get_plugin_dialog_session",
    "prepare_plugin_display",
    "get_plugin_display_session",
    "prepare_host_clipboard",
    "get_host_clipboard_session",
    "plugin_legacy_node_usage",
    "prepare_legacy_node",
    "get_legacy_node_session",
    "read_plugin_preload_module",
    "get_task_run",
];

#[derive(Default)]
struct Counts {
    received: [u32; STARTUP_COMMANDS.len()],
    accepted: [u32; STARTUP_COMMANDS.len()],
    not_matched: [u32; STARTUP_COMMANDS.len()],
    total_received: u32,
    other_app_handler_commands: u32,
    last_received: Option<usize>,
    last_accepted: Option<usize>,
    saturated: bool,
}

#[derive(Default)]
pub(super) struct StartupCommandReceipts(Mutex<Counts>);

impl StartupCommandReceipts {
    fn increment(value: &mut u32, saturated: &mut bool) {
        if *value == u32::MAX {
            *saturated = true;
        } else {
            *value += 1;
        }
    }

    fn received(&self, command: &str) -> Option<usize> {
        let mut guard = self.0.lock();
        let counts = &mut *guard;
        Self::increment(&mut counts.total_received, &mut counts.saturated);
        if let Some(index) = STARTUP_COMMANDS.iter().position(|known| *known == command) {
            counts.last_received = Some(index);
            Self::increment(&mut counts.received[index], &mut counts.saturated);
            Some(index)
        } else {
            Self::increment(
                &mut counts.other_app_handler_commands,
                &mut counts.saturated,
            );
            None
        }
    }

    fn handler_returned(&self, index: usize, accepted: bool) {
        let mut guard = self.0.lock();
        let counts = &mut *guard;
        if accepted {
            counts.last_accepted = Some(index);
            Self::increment(&mut counts.accepted[index], &mut counts.saturated);
        } else {
            Self::increment(&mut counts.not_matched[index], &mut counts.saturated);
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        let counts = self.0.lock();
        let commands: Vec<_> = STARTUP_COMMANDS
            .iter()
            .enumerate()
            .map(|(index, code)| {
                json!({
                    "code": code,
                    "received": counts.received[index],
                    "handlerAccepted": counts.accepted[index],
                    "handlerNotMatched": counts.not_matched[index],
                })
            })
            .collect();
        json!({
            "coverage": "registered-app-invoke-handler-only",
            "pluginNamespaceCoverage": "not-observed-by-app-invoke-handler",
            "handlerReturnMeaning": "synchronous routing acceptance only; async command completion is not observed",
            "totalAppHandlerReceipts": counts.total_received,
            "otherAppHandlerCommandCount": counts.other_app_handler_commands,
            "lastReceivedStartupCode": counts.last_received.map(|index| STARTUP_COMMANDS[index]),
            "lastHandlerAcceptedStartupCode": counts.last_accepted.map(|index| STARTUP_COMMANDS[index]),
            "countSaturated": counts.saturated,
            "startupCommands": commands,
        })
    }
}

pub(super) fn wrap(
    handler: Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync>,
) -> (
    Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync>,
    Arc<StartupCommandReceipts>,
) {
    let receipts = Arc::new(StartupCommandReceipts::default());
    let for_handler = receipts.clone();
    let wrapped = Box::new(move |invoke: Invoke<Wry>| {
        let index = for_handler.received(invoke.message.command());
        let accepted = handler(invoke);
        if let Some(index) = index {
            for_handler.handler_returned(index, accepted);
        }
        accepted
    });
    (wrapped, receipts)
}

#[cfg(test)]
mod tests {
    use super::StartupCommandReceipts;

    #[test]
    fn receipt_is_visible_before_handler_return_and_does_not_claim_completion() {
        let receipts = StartupCommandReceipts::default();
        let index = receipts.received("prepare_plugin_data").unwrap();
        let snapshot = receipts.snapshot();
        assert_eq!(snapshot["totalAppHandlerReceipts"], 1);
        assert_eq!(snapshot["lastReceivedStartupCode"], "prepare_plugin_data");
        assert!(snapshot["handlerReturnMeaning"]
            .as_str()
            .unwrap()
            .contains("completion is not observed"));
        assert_eq!(snapshot["startupCommands"][5]["received"], 1);
        assert_eq!(snapshot["startupCommands"][5]["handlerAccepted"], 0);
        receipts.handler_returned(index, true);
        let snapshot = receipts.snapshot();
        assert_eq!(snapshot["startupCommands"][5]["handlerAccepted"], 1);
        assert_eq!(
            snapshot["lastHandlerAcceptedStartupCode"],
            "prepare_plugin_data"
        );
    }

    #[test]
    fn other_app_commands_are_never_retained_or_serialized() {
        let receipts = StartupCommandReceipts::default();
        assert!(receipts.received("native_image_toolbox_stage").is_none());
        assert!(receipts.received("/private/user/image.png").is_none());
        let encoded = receipts.snapshot().to_string();
        assert_eq!(receipts.snapshot()["otherAppHandlerCommandCount"], 2);
        assert!(!encoded.contains("native_image_toolbox_stage"));
        assert!(!encoded.contains("/private/user/image.png"));
    }

    #[test]
    fn fixed_allowlist_counts_and_last_code_are_bounded_to_known_codes() {
        let receipts = StartupCommandReceipts::default();
        for _ in 0..300 {
            let index = receipts.received("read_plugin_preload_module").unwrap();
            receipts.handler_returned(index, true);
        }
        let snapshot = receipts.snapshot();
        assert_eq!(
            snapshot["lastReceivedStartupCode"],
            "read_plugin_preload_module"
        );
        assert_eq!(snapshot["startupCommands"][18]["received"], 300);
        assert_eq!(snapshot["startupCommands"][18]["handlerAccepted"], 300);
        assert_eq!(snapshot["startupCommands"].as_array().unwrap().len(), 20);
        assert_eq!(snapshot["countSaturated"], false);
    }

    #[test]
    fn counters_saturate_at_u32_max_without_wrapping() {
        let receipts = StartupCommandReceipts::default();
        {
            let mut guard = receipts.0.lock();
            guard.total_received = u32::MAX - 1;
            guard.received[0] = u32::MAX - 1;
            guard.accepted[0] = u32::MAX - 1;
            guard.not_matched[2] = u32::MAX;
            guard.other_app_handler_commands = u32::MAX - 1;
        }

        let accepted = receipts.received("activate_file_content_feature").unwrap();
        receipts.handler_returned(accepted, true);
        assert!(receipts.received("native_image_toolbox_stage").is_none());
        assert!(receipts.received("not-a-command-name").is_none());
        let not_matched = receipts.received("prepare_plugin_page").unwrap();
        receipts.handler_returned(not_matched, false);

        let snapshot = receipts.snapshot();
        assert_eq!(snapshot["totalAppHandlerReceipts"], u32::MAX);
        assert_eq!(snapshot["otherAppHandlerCommandCount"], u32::MAX);
        assert_eq!(snapshot["startupCommands"][0]["received"], u32::MAX);
        assert_eq!(snapshot["startupCommands"][0]["handlerAccepted"], u32::MAX);
        assert_eq!(
            snapshot["startupCommands"][2]["handlerNotMatched"],
            u32::MAX
        );
        assert_eq!(snapshot["countSaturated"], true);
    }

    #[test]
    fn false_handler_result_is_not_reported_as_accepted() {
        let receipts = StartupCommandReceipts::default();
        let index = receipts.received("prepare_legacy_node").unwrap();
        receipts.handler_returned(index, false);
        let snapshot = receipts.snapshot();
        assert_eq!(snapshot["startupCommands"][16]["received"], 1);
        assert_eq!(snapshot["startupCommands"][16]["handlerAccepted"], 0);
        assert_eq!(snapshot["startupCommands"][16]["handlerNotMatched"], 1);
    }
}
