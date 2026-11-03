use std::time::Duration;

use tokio::{
    task::JoinHandle,
    time::{sleep, sleep_until, Instant},
};

use super::{
    hide_once, LeaseTarget, WindowFacts, FAILURE_FOCUS, FAILURE_PRESENTATION, FAILURE_WATCHDOG,
};

const SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const INITIAL_VISIBILITY_LIMIT: Duration = Duration::from_secs(1);

async fn observe(target: &LeaseTarget) -> Result<WindowFacts, &'static str> {
    super::trace::observe_visibility(&target.app, &target.harness, &target.run_id, &target.trace)
        .await
}

/// Lets WindowServer publish initial active-space and occlusion facts before validating them.
pub(super) async fn wait_for_initial_visibility(
    target: &LeaseTarget,
    baseline: WindowFacts,
    deadline: Instant,
) -> Result<(), &'static str> {
    let visibility_deadline = Instant::now() + INITIAL_VISIBILITY_LIMIT;
    loop {
        if let Some(error) = target.state.failure_code() {
            return Err(error);
        }

        let sample = tokio::select! {
            biased;
            _ = sleep_until(deadline) => {
                return Err(fail(target, FAILURE_WATCHDOG, super::WATCHDOG_EXPIRED));
            }
            _ = sleep_until(visibility_deadline) => {
                return Err(fail(target, FAILURE_PRESENTATION, super::PRESENTATION_FAILED));
            }
            sample = observe(target) => sample,
        };
        match sample {
            Ok(facts) if facts.visible_unfocused_since(baseline) => return Ok(()),
            Ok(facts) if facts.focus_changed_since(baseline) => {
                return Err(fail(target, FAILURE_FOCUS, super::FOCUS_CHANGED));
            }
            Ok(_) => {}
            Err(_) => {
                return Err(fail(
                    target,
                    FAILURE_PRESENTATION,
                    super::PRESENTATION_FAILED,
                ))
            }
        }

        tokio::select! {
            biased;
            _ = sleep_until(deadline) => {
                return Err(fail(target, FAILURE_WATCHDOG, super::WATCHDOG_EXPIRED));
            }
            _ = sleep_until(visibility_deadline) => {
                return Err(fail(target, FAILURE_PRESENTATION, super::PRESENTATION_FAILED));
            }
            _ = sleep(SAMPLE_INTERVAL) => {}
        }
    }
}

/// Samples only while this short presentation lease is active; no observer is installed here.
pub(super) fn start(
    target: LeaseTarget,
    baseline: WindowFacts,
    deadline: Instant,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if !target
                .state
                .active
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return;
            }
            tokio::select! {
                _ = sleep_until(deadline) => {
                    expire(&target).await;
                    return;
                }
                _ = sleep(SAMPLE_INTERVAL) => {}
            }
            if !target
                .state
                .active
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return;
            }

            let facts = tokio::select! {
                _ = sleep_until(deadline) => {
                    expire(&target).await;
                    return;
                }
                facts = observe(&target) => facts,
            };
            if !target
                .state
                .active
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return;
            }
            if Instant::now() >= deadline {
                expire(&target).await;
                return;
            }

            match facts {
                Ok(facts) if facts.visible_unfocused_since(baseline) => {}
                Ok(facts) => {
                    let failure = if facts.focus_changed_since(baseline) {
                        FAILURE_FOCUS
                    } else {
                        FAILURE_PRESENTATION
                    };
                    if claim_failure(&target, failure) {
                        let _ = hide_once(&target).await;
                    }
                    return;
                }
                Err(_) => {
                    if claim_failure(&target, FAILURE_PRESENTATION) {
                        let _ = hide_once(&target).await;
                    }
                    return;
                }
            }
        }
    })
}

async fn expire(target: &LeaseTarget) {
    if claim_failure(target, FAILURE_WATCHDOG) {
        let _ = hide_once(target).await;
    }
}

fn claim_failure(target: &LeaseTarget, failure: u8) -> bool {
    if !target
        .state
        .active
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return false;
    }
    if target
        .state
        .failure
        .compare_exchange(
            super::FAILURE_NONE,
            failure,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return false;
    }
    target
        .state
        .active
        .store(false, std::sync::atomic::Ordering::Release);
    true
}

fn fail(target: &LeaseTarget, failure: u8, fallback: &'static str) -> &'static str {
    target.state.fail(failure);
    target.state.failure_code().unwrap_or(fallback)
}
