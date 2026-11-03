use std::{
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use super::{delay_for_setting, AutoBackController, Phase, RuntimeTimer, TimerState, TimerTask};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FakeAction {
    AbortAndReap(u8),
    Reap(u8),
}

#[derive(Debug)]
struct FakeTimer {
    id: u8,
    actions: Arc<Mutex<Vec<FakeAction>>>,
}

impl TimerTask for FakeTimer {
    fn abort_and_reap(self) {
        self.actions
            .lock()
            .unwrap()
            .push(FakeAction::AbortAndReap(self.id));
    }

    fn reap(self) {
        self.actions.lock().unwrap().push(FakeAction::Reap(self.id));
    }
}

fn timer(id: u8, actions: &Arc<Mutex<Vec<FakeAction>>>) -> FakeTimer {
    FakeTimer {
        id,
        actions: actions.clone(),
    }
}

struct DropWitness(Sender<()>);

impl Drop for DropWitness {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

fn pending_runtime_task() -> (RuntimeTimer, Receiver<()>) {
    let (started_tx, started_rx) = mpsc::channel();
    let (dropped_tx, dropped_rx) = mpsc::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _witness = DropWitness(dropped_tx);
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    if started_rx.recv_timeout(Duration::from_secs(5)).is_err() {
        RuntimeTimer(task).abort_and_reap();
        panic!("runtime task should start before it is installed");
    }
    (RuntimeTimer(task), dropped_rx)
}

fn gated_runtime_task() -> (RuntimeTimer, Receiver<()>, tokio::sync::oneshot::Sender<()>) {
    let (started_tx, started_rx) = mpsc::channel();
    let (dropped_tx, dropped_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _witness = DropWitness(dropped_tx);
        let _ = started_tx.send(());
        let _ = finish_rx.await;
    });
    if started_rx.recv_timeout(Duration::from_secs(5)).is_err() {
        RuntimeTimer(task).abort_and_reap();
        panic!("runtime task should start before it is installed");
    }
    (RuntimeTimer(task), dropped_rx, finish_tx)
}

fn install_wait(controller: &AutoBackController, generation: u64, task: RuntimeTimer) {
    if let Err(task) = controller.install_wait(generation, task) {
        task.abort_and_reap();
        panic!("waiting runtime task should install into its active generation");
    }
}

fn assert_dropped(controller: &AutoBackController, receiver: Receiver<()>) {
    if receiver.recv_timeout(Duration::from_secs(5)).is_err() {
        controller.stop();
        panic!("cancelled runtime task should drop and be reaped");
    }
}

#[test]
fn maps_only_the_frozen_delay_values() {
    let cases = [
        ("immediately", Some(Duration::ZERO)),
        ("30s", Some(Duration::from_secs(30))),
        ("1m", Some(Duration::from_secs(60))),
        ("3m", Some(Duration::from_secs(180))),
        ("5m", Some(Duration::from_secs(300))),
        ("10m", Some(Duration::from_secs(600))),
        ("never", None),
        ("30S", None),
        ("2m", None),
        ("", None),
    ];
    for (setting, expected) in cases {
        assert_eq!(delay_for_setting(setting), expected, "{setting}");
    }
}

#[test]
fn duplicate_hide_replaces_wait_and_show_cancels_only_waiting_work() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();

    let first = state.begin_hide();
    let first_generation = first.generation.unwrap();
    assert!(!first.replaced_timer);
    assert!(state.arm(first_generation, Instant::now() + Duration::from_secs(30)));
    state
        .install_wait(first_generation, timer(1, &actions))
        .unwrap();

    let second = state.begin_hide();
    assert!(second.replaced_timer);
    second.old_task.unwrap().abort_and_reap();
    let second_generation = second.generation.unwrap();
    assert!(state.arm(second_generation, Instant::now() + Duration::from_secs(60)));
    state
        .install_wait(second_generation, timer(2, &actions))
        .unwrap();
    assert!(state.wait_task.is_some());

    state.cancel().unwrap().abort_and_reap();
    assert!(state.wait_task.is_none());
    assert_eq!(
        *actions.lock().unwrap(),
        vec![FakeAction::AbortAndReap(1), FakeAction::AbortAndReap(2)]
    );
    assert!(!state.claim(second_generation).accepted);
}

#[test]
fn stale_callback_and_late_wait_install_are_fenced() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let first = state.begin_hide();
    let first_generation = first.generation.unwrap();
    assert!(state.arm(first_generation, Instant::now() + Duration::from_secs(30)));
    state
        .install_wait(first_generation, timer(1, &actions))
        .unwrap();

    let second = state.begin_hide();
    second.old_task.unwrap().abort_and_reap();
    let second_generation = second.generation.unwrap();
    assert!(!state.claim(first_generation).accepted);
    assert!(state.arm(second_generation, Instant::now() + Duration::from_secs(60)));
    assert!(state
        .install_wait(second_generation, timer(2, &actions))
        .is_ok());

    state.cancel().unwrap().abort_and_reap();
    if let Err(task) = state.install_wait(second_generation, timer(3, &actions)) {
        task.abort_and_reap();
    }
    assert!(!state.claim(second_generation).accepted);
    assert_eq!(
        *actions.lock().unwrap(),
        vec![
            FakeAction::AbortAndReap(1),
            FakeAction::AbortAndReap(2),
            FakeAction::AbortAndReap(3),
        ]
    );
}

#[test]
fn visible_main_window_rejects_and_cancels_the_expiring_wait() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let generation = state.begin_hide().generation.unwrap();
    assert!(state.arm(generation, Instant::now()));
    state.install_wait(generation, timer(1, &actions)).unwrap();

    let claim = state.claim_if_hidden(generation, false);
    assert!(!claim.accepted);
    assert!(claim.elapsed_task.is_none());
    claim.cancelled_task.unwrap().abort_and_reap();
    assert_eq!(state.phase, Phase::Idle);
    assert!(!state.claim(generation).accepted);
    assert_eq!(*actions.lock().unwrap(), vec![FakeAction::AbortAndReap(1)]);
}

#[test]
fn stop_aborts_wait_task_and_rejects_late_install() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let begun = state.begin_hide();
    let generation = begun.generation.unwrap();
    assert!(state.arm(generation, Instant::now() + Duration::from_secs(30)));
    state.install_wait(generation, timer(1, &actions)).unwrap();

    if let Some(task) = state.stop().wait_task {
        task.abort_and_reap();
    }
    assert!(state.begin_hide().generation.is_none());
    if let Err(task) = state.install_wait(generation, timer(2, &actions)) {
        task.abort_and_reap();
    }
    assert!(!state.claim(generation).accepted);
    assert_eq!(
        *actions.lock().unwrap(),
        vec![FakeAction::AbortAndReap(1), FakeAction::AbortAndReap(2)]
    );
}

#[test]
fn setting_changes_do_not_rewrite_an_armed_deadline() {
    let mut state = TimerState::<FakeTimer>::default();
    let delay_at_hide = delay_for_setting("1m").unwrap();
    let deadline = Instant::now() + delay_at_hide;
    let generation = state.begin_hide().generation.unwrap();
    assert!(state.arm(generation, deadline));

    // Settings are sampled only by begin-hide orchestration. A later preference
    // value is available for the next hide, but no operation mutates this deadline.
    assert_eq!(delay_for_setting("30s"), Some(Duration::from_secs(30)));
    assert_eq!(state.deadline, Some(deadline));
}

#[test]
fn never_policy_replaces_pending_work_without_arming_another_timer() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let prior = state.begin_hide();
    let prior_generation = prior.generation.unwrap();
    assert!(state.arm(prior_generation, Instant::now() + Duration::from_secs(30)));
    state
        .install_wait(prior_generation, timer(1, &actions))
        .unwrap();

    let current = state.begin_hide();
    assert!(current.replaced_timer);
    current.old_task.unwrap().abort_and_reap();
    let current_generation = current.generation.unwrap();
    assert_eq!(delay_for_setting("never"), None);
    state.abandon(current_generation);

    assert!(state.wait_task.is_none());
    assert_eq!(state.deadline, None);
    assert!(!state.claim(current_generation).accepted);
    assert_eq!(*actions.lock().unwrap(), vec![FakeAction::AbortAndReap(1)]);
}

#[test]
fn claimed_return_coalesces_hides_and_show_does_not_abort_it() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let generation = state.begin_hide().generation.unwrap();
    assert!(state.arm(generation, Instant::now()));
    state.install_wait(generation, timer(1, &actions)).unwrap();

    let claim = state.claim(generation);
    assert!(claim.accepted);
    claim.elapsed_task.unwrap().reap();
    state
        .install_return(generation, timer(2, &actions))
        .unwrap();

    let duplicate_hide = state.begin_hide();
    assert!(duplicate_hide.generation.is_none());
    assert!(!duplicate_hide.replaced_timer);
    assert_eq!(state.phase, Phase::Returning(generation));
    assert!(state.cancel().is_none());
    assert_eq!(state.phase, Phase::Returning(generation));
    assert!(state.return_task.is_some());

    state.finish_return(generation).unwrap().reap();
    assert_eq!(state.phase, Phase::Idle);
    assert_eq!(
        *actions.lock().unwrap(),
        vec![FakeAction::Reap(1), FakeAction::Reap(2)]
    );
}

#[test]
fn stop_aborts_claimed_return_and_blocks_late_completion() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let generation = state.begin_hide().generation.unwrap();
    assert!(state.arm(generation, Instant::now()));
    state.install_wait(generation, timer(1, &actions)).unwrap();
    let claim = state.claim(generation);
    claim.elapsed_task.unwrap().reap();
    state
        .install_return(generation, timer(2, &actions))
        .unwrap();

    if let Some(task) = state.stop().return_task {
        task.abort_and_reap();
    }
    assert_eq!(state.phase, Phase::Stopped);
    assert!(state.finish_return(generation).is_none());
    if let Err(task) = state.install_return(generation, timer(3, &actions)) {
        task.abort_and_reap();
    }
    assert_eq!(
        *actions.lock().unwrap(),
        vec![
            FakeAction::Reap(1),
            FakeAction::AbortAndReap(2),
            FakeAction::AbortAndReap(3),
        ]
    );
}

#[test]
fn completion_before_late_return_install_cannot_revive_state() {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let mut state = TimerState::default();
    let generation = state.begin_hide().generation.unwrap();
    assert!(state.arm(generation, Instant::now()));
    let claim = state.claim(generation);
    assert!(claim.accepted);

    assert!(state.finish_return(generation).is_none());
    assert_eq!(state.phase, Phase::Idle);
    let next_generation = state.begin_hide().generation.unwrap();
    assert!(state.finish_return(generation).is_none());
    assert_eq!(state.phase, Phase::Preparing(next_generation));
    if let Err(task) = state.install_return(generation, timer(1, &actions)) {
        task.abort_and_reap();
    }
    assert_eq!(state.phase, Phase::Preparing(next_generation));
    assert_eq!(*actions.lock().unwrap(), vec![FakeAction::AbortAndReap(1)]);
}

#[test]
fn controller_reaps_real_runtime_wait_and_return_futures() {
    let wait_controller = AutoBackController::default();
    let wait_generation = wait_controller.begin_hide().unwrap();
    assert!(wait_controller.arm(wait_generation, Instant::now() + Duration::from_secs(30)));
    let (wait_task, wait_dropped) = pending_runtime_task();
    install_wait(&wait_controller, wait_generation, wait_task);
    wait_controller.cancel();
    assert_dropped(&wait_controller, wait_dropped);

    let return_controller = AutoBackController::default();
    let return_generation = return_controller.begin_hide().unwrap();
    assert!(return_controller.arm(return_generation, Instant::now()));
    let (elapsed_task, elapsed_dropped, finish_wait) = gated_runtime_task();
    install_wait(&return_controller, return_generation, elapsed_task);
    let claim = return_controller.claim_if_hidden(return_generation, true);
    assert!(claim.accepted);
    finish_wait.send(()).expect("release completed wait task");
    claim.elapsed_task.unwrap().reap();
    assert_dropped(&return_controller, elapsed_dropped);

    let (return_task, return_dropped) = pending_runtime_task();
    if let Err(task) = return_controller.install_return(return_generation, return_task) {
        task.abort_and_reap();
        panic!("return runtime task should install after its claim");
    }
    return_controller.stop();
    assert_dropped(&return_controller, return_dropped);
}
