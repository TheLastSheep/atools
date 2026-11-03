//! Bounded real-profile scenario milestones, separate from the exact WebView boot ledger.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_FRONTEND_EVENTS: usize = 24;
pub const REAL_PROFILE_LABEL: &str = "application-uninstaller";
const MAX_NATIVE_CALLS_PER_COMMAND: u8 = 4;

pub fn tracks_native_calls(profile_label: &str) -> bool {
    profile_label == REAL_PROFILE_LABEL
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrontendScenarioEvent {
    ScenarioEntered,
    FixtureReceived,
    InitialSnapshotReceived,
    ScanReady,
    RowFound,
    InspectionActionable,
    InspectionClicked,
    InspectionCompleted,
    ConversionClicked,
    PermissionRequestObserved,
    PermissionApprovalClicked,
    TaskRunTerminalObserved,
    InstalledInventoryVerified,
    FinalSnapshotReceived,
    ScenarioCompleted,
    ScenarioCatchEntered,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrontendScenarioMessage {
    pub run_token: String,
    pub event: FrontendScenarioEvent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCommand {
    Fixture,
    Snapshot,
    Scan,
    Inspect,
}

#[derive(Clone, Copy, Debug, Default)]
struct CommandCounts {
    received: u8,
    completed: u8,
    succeeded: u8,
    overflow: bool,
}

impl CommandCounts {
    fn receive(&mut self) {
        if self.received >= MAX_NATIVE_CALLS_PER_COMMAND {
            self.overflow = true;
            return;
        }
        self.received += 1;
    }

    fn complete(&mut self, succeeded: bool) {
        if self.completed >= MAX_NATIVE_CALLS_PER_COMMAND {
            self.overflow = true;
            return;
        }
        self.completed += 1;
        if succeeded {
            self.succeeded += 1;
        }
    }
}

#[derive(Debug)]
pub struct ScenarioLedger {
    run_token: String,
    frontend_events: Vec<FrontendScenarioEvent>,
    frontend_ipc_count: u8,
    frontend_overflow: bool,
    fixture: CommandCounts,
    snapshot: CommandCounts,
    scan: CommandCounts,
    inspect: CommandCounts,
    inspection_result: super::inspection_observation::InspectionObservation,
}

pub fn record_received_for_profile(
    profile_label: &str,
    ledger: &mut ScenarioLedger,
    command: NativeCommand,
) -> Result<(), &'static str> {
    if tracks_native_calls(profile_label) {
        ledger.receive(command)
    } else {
        Ok(())
    }
}

pub fn record_completed_for_profile(
    profile_label: &str,
    ledger: &mut ScenarioLedger,
    command: NativeCommand,
    succeeded: bool,
) -> Result<(), &'static str> {
    if tracks_native_calls(profile_label) {
        ledger.complete(command, succeeded)
    } else {
        Ok(())
    }
}

impl ScenarioLedger {
    pub fn new(run_token: String) -> Self {
        Self {
            run_token,
            frontend_events: Vec::with_capacity(MAX_FRONTEND_EVENTS),
            frontend_ipc_count: 0,
            frontend_overflow: false,
            fixture: CommandCounts::default(),
            snapshot: CommandCounts::default(),
            scan: CommandCounts::default(),
            inspect: CommandCounts::default(),
            inspection_result: super::inspection_observation::InspectionObservation::default(),
        }
    }

    pub fn record_inspection_result(&mut self, result: Result<&Value, &str>) {
        self.inspection_result.record(result);
    }

    pub fn record_frontend(
        &mut self,
        message: FrontendScenarioMessage,
    ) -> Result<(), &'static str> {
        if message.run_token != self.run_token {
            return Err("Source-build scenario token mismatch");
        }
        self.frontend_ipc_count = self.frontend_ipc_count.saturating_add(1);
        if self.frontend_events.len() >= MAX_FRONTEND_EVENTS {
            self.frontend_overflow = true;
            return Err("Source-build scenario event limit reached");
        }
        self.frontend_events.push(message.event);
        Ok(())
    }

    pub fn receive(&mut self, command: NativeCommand) -> Result<(), &'static str> {
        let counts = self.counts_mut(command);
        if counts.received >= MAX_NATIVE_CALLS_PER_COMMAND {
            counts.overflow = true;
            return Err("Source-build native command limit reached");
        }
        counts.receive();
        Ok(())
    }

    pub fn complete(
        &mut self,
        command: NativeCommand,
        succeeded: bool,
    ) -> Result<(), &'static str> {
        let counts = self.counts_mut(command);
        if counts.completed >= counts.received || counts.completed >= MAX_NATIVE_CALLS_PER_COMMAND {
            counts.overflow = true;
            return Err("Source-build native command completion mismatch");
        }
        counts.complete(succeeded);
        Ok(())
    }

    fn counts_mut(&mut self, command: NativeCommand) -> &mut CommandCounts {
        match command {
            NativeCommand::Fixture => &mut self.fixture,
            NativeCommand::Snapshot => &mut self.snapshot,
            NativeCommand::Scan => &mut self.scan,
            NativeCommand::Inspect => &mut self.inspect,
        }
    }

    fn counts_value(counts: CommandCounts) -> Value {
        json!({"received":counts.received,"completed":counts.completed,"succeeded":counts.succeeded,
            "failed":counts.completed.saturating_sub(counts.succeeded),"overflow":counts.overflow})
    }

    pub fn snapshot(&self, required: bool) -> Value {
        if !required {
            return json!({"status":"not_exercised","passed":false});
        }
        let expected = [
            FrontendScenarioEvent::ScenarioEntered,
            FrontendScenarioEvent::FixtureReceived,
            FrontendScenarioEvent::InitialSnapshotReceived,
            FrontendScenarioEvent::ScanReady,
            FrontendScenarioEvent::RowFound,
            FrontendScenarioEvent::InspectionActionable,
            FrontendScenarioEvent::InspectionClicked,
            FrontendScenarioEvent::InspectionCompleted,
            FrontendScenarioEvent::ConversionClicked,
            FrontendScenarioEvent::PermissionRequestObserved,
            FrontendScenarioEvent::PermissionApprovalClicked,
            FrontendScenarioEvent::TaskRunTerminalObserved,
            FrontendScenarioEvent::InstalledInventoryVerified,
            FrontendScenarioEvent::FinalSnapshotReceived,
            FrontendScenarioEvent::ScenarioCompleted,
        ];
        let exact_frontend_sequence = self.frontend_events.as_slice() == &expected[..];
        let frontend_message_count_matches = usize::from(self.frontend_ipc_count) == expected.len();
        let frontend_failed = self
            .frontend_events
            .iter()
            .any(|event| *event == FrontendScenarioEvent::ScenarioCatchEntered);
        let pairs_ok = [self.fixture, self.snapshot, self.scan, self.inspect]
            .iter()
            .all(|counts| counts.received == counts.completed && !counts.overflow);
        let expected_commands = self.fixture.received == 2
            && self.fixture.succeeded == 2
            && self.snapshot.received == 2
            && self.snapshot.succeeded == 2
            && self.scan.received == 1
            && self.scan.succeeded == 1
            && self.inspect.received == 1
            && self.inspect.succeeded == 1;
        let overflow = self.frontend_overflow
            || [self.fixture, self.snapshot, self.scan, self.inspect]
                .iter()
                .any(|counts| counts.overflow);
        let passed = exact_frontend_sequence
            && frontend_message_count_matches
            && !frontend_failed
            && pairs_ok
            && expected_commands
            && self.frontend_events.len() <= MAX_FRONTEND_EVENTS
            && !overflow;
        json!({
            "status": if passed { "passed" } else { "incomplete_or_failed" },
            "passed": passed,
            "frontendEvents": self.frontend_events,
            "frontendEventCount": self.frontend_events.len(),
            "frontendDiagnosticIpcCount": self.frontend_ipc_count,
            "frontendMessageCountMatchesExpected": frontend_message_count_matches,
            "frontendOverflow": self.frontend_overflow,
            "exactFrontendSuccessSequence": exact_frontend_sequence,
            "nativeCommands": {
                "fixture":Self::counts_value(self.fixture),
                "snapshot":Self::counts_value(self.snapshot),
                "scan":Self::counts_value(self.scan),
                "inspect":Self::counts_value(self.inspect)
            },
            "inspectionResult": self.inspection_result.snapshot(),
            "nativeReceivedCompletedPairsMatch": pairs_ok,
            "nativeCommandCountsMatchExpected": expected_commands,
            "overflow": overflow
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "24d8b68f-23ad-49dd-9d07-b5a0a0b705aa";

    fn record_success(ledger: &mut ScenarioLedger) {
        for event in [
            FrontendScenarioEvent::ScenarioEntered,
            FrontendScenarioEvent::FixtureReceived,
            FrontendScenarioEvent::InitialSnapshotReceived,
            FrontendScenarioEvent::ScanReady,
            FrontendScenarioEvent::RowFound,
            FrontendScenarioEvent::InspectionActionable,
            FrontendScenarioEvent::InspectionClicked,
            FrontendScenarioEvent::InspectionCompleted,
            FrontendScenarioEvent::ConversionClicked,
            FrontendScenarioEvent::PermissionRequestObserved,
            FrontendScenarioEvent::PermissionApprovalClicked,
            FrontendScenarioEvent::TaskRunTerminalObserved,
            FrontendScenarioEvent::InstalledInventoryVerified,
            FrontendScenarioEvent::FinalSnapshotReceived,
            FrontendScenarioEvent::ScenarioCompleted,
        ] {
            ledger
                .record_frontend(FrontendScenarioMessage {
                    run_token: TOKEN.into(),
                    event,
                })
                .unwrap();
        }
        for (command, count) in [
            (NativeCommand::Fixture, 2),
            (NativeCommand::Snapshot, 2),
            (NativeCommand::Scan, 1),
            (NativeCommand::Inspect, 1),
        ] {
            for _ in 0..count {
                record_received_for_profile(REAL_PROFILE_LABEL, ledger, command).unwrap();
                record_completed_for_profile(REAL_PROFILE_LABEL, ledger, command, true).unwrap();
            }
        }
    }

    #[test]
    fn real_profile_success_requires_ordered_frontend_and_paired_native_commands() {
        let mut ledger = ScenarioLedger::new(TOKEN.into());
        assert_eq!(ledger.snapshot(true)["passed"], false);
        record_success(&mut ledger);
        let snapshot = ledger.snapshot(true);
        assert_eq!(snapshot["passed"], true);
        assert_eq!(snapshot["frontendEventCount"], 15);
        assert_eq!(snapshot["nativeCommands"]["fixture"]["received"], 2);
        assert_eq!(snapshot["nativeCommands"]["snapshot"]["completed"], 2);
    }

    #[test]
    fn synthetic_profile_commands_preserve_unbounded_legacy_behavior() {
        assert!(!tracks_native_calls("synthetic"));
        assert!(tracks_native_calls(REAL_PROFILE_LABEL));
        let mut ledger = ScenarioLedger::new(TOKEN.into());
        for command in [
            NativeCommand::Fixture,
            NativeCommand::Snapshot,
            NativeCommand::Scan,
            NativeCommand::Inspect,
        ] {
            for _ in 0..9 {
                record_received_for_profile("synthetic", &mut ledger, command).unwrap();
                record_completed_for_profile("synthetic", &mut ledger, command, true).unwrap();
            }
        }
        assert_eq!(ledger.snapshot(false)["status"], "not_exercised");
        assert_eq!(ledger.snapshot(false)["passed"], false);
        assert_eq!(ledger.fixture.received, 0);
        assert_eq!(ledger.snapshot.received, 0);
        assert_eq!(ledger.scan.received, 0);
        assert_eq!(ledger.inspect.received, 0);
    }

    #[test]
    fn real_profile_fifth_call_is_rejected_and_marks_overflow() {
        let mut ledger = ScenarioLedger::new(TOKEN.into());
        for command in [
            NativeCommand::Fixture,
            NativeCommand::Snapshot,
            NativeCommand::Scan,
            NativeCommand::Inspect,
        ] {
            for _ in 0..MAX_NATIVE_CALLS_PER_COMMAND {
                record_received_for_profile(REAL_PROFILE_LABEL, &mut ledger, command).unwrap();
            }
            assert!(record_received_for_profile(REAL_PROFILE_LABEL, &mut ledger, command).is_err());
        }
        assert_eq!(ledger.snapshot(true)["overflow"], true);
    }

    #[test]
    fn completion_failure_and_frontend_catch_remain_visible_and_fail() {
        let mut ledger = ScenarioLedger::new(TOKEN.into());
        record_success(&mut ledger);
        ledger
            .frontend_events
            .push(FrontendScenarioEvent::ScenarioCatchEntered);
        assert_eq!(ledger.snapshot(true)["passed"], false);

        let mut failed_command = ScenarioLedger::new(TOKEN.into());
        assert!(failed_command
            .complete(NativeCommand::Inspect, true)
            .is_err());
        failed_command.receive(NativeCommand::Inspect).unwrap();
        failed_command
            .complete(NativeCommand::Inspect, false)
            .unwrap();
        assert_eq!(
            failed_command.snapshot(true)["nativeCommands"]["inspect"]["failed"],
            1
        );
        assert_eq!(failed_command.snapshot(true)["passed"], false);
    }

    #[test]
    fn repeated_native_calls_reordered_events_and_unknown_payload_fields_fail_closed() {
        let mut repeated = ScenarioLedger::new(TOKEN.into());
        record_success(&mut repeated);
        repeated.receive(NativeCommand::Scan).unwrap();
        repeated.complete(NativeCommand::Scan, true).unwrap();
        assert_eq!(
            repeated.snapshot(true)["nativeCommandCountsMatchExpected"],
            false
        );
        assert_eq!(repeated.snapshot(true)["passed"], false);

        let mut reordered = ScenarioLedger::new(TOKEN.into());
        record_success(&mut reordered);
        assert_eq!(reordered.snapshot(true)["passed"], true);
        reordered.frontend_events.swap(3, 4);
        assert_eq!(
            reordered.snapshot(true)["exactFrontendSuccessSequence"],
            false
        );
        assert_eq!(reordered.snapshot(true)["passed"], false);

        assert!(serde_json::from_str::<FrontendScenarioMessage>(
            r#"{"runToken":"x","event":"row_found","path":"private"}"#
        )
        .is_err());
    }
}
