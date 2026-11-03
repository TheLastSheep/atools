use serde::Serialize;
use std::time::{Duration, Instant};

pub(super) const SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
pub(super) const OBSERVED_FOOTPRINT_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const UNAVAILABLE_SAMPLE_LIMIT: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum MonitorFailure {
    ObservedFootprintLimit,
    ResourceMonitorUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceObservation {
    /// `None` means the child was never spawned and elapsed time was not measured.
    pub(crate) elapsed_milliseconds: Option<u64>,
    /// Successful physical-footprint reads; failed reads are not reported as zero.
    pub(crate) sample_count: u32,
    pub(crate) unavailable_sample_count: u32,
    pub(crate) peak_observed_physical_footprint_bytes: Option<u64>,
    pub(crate) sample_interval_milliseconds: u64,
    pub(crate) observed_footprint_limit_bytes: u64,
}

pub(super) struct Monitor {
    started: Instant,
    next_sample: Instant,
    sample_count: u32,
    unavailable_count: u32,
    consecutive_unavailable: u8,
    peak_bytes: Option<u64>,
}

impl Monitor {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            next_sample: started,
            sample_count: 0,
            unavailable_count: 0,
            consecutive_unavailable: 0,
            peak_bytes: None,
        }
    }

    pub fn sample_if_due(&mut self, pid: i32, now: Instant) -> Option<MonitorFailure> {
        if now < self.next_sample {
            return None;
        }
        self.next_sample = now + SAMPLE_INTERVAL;
        match sampled_physical_footprint(pid) {
            Some(bytes) => {
                self.sample_count = self.sample_count.saturating_add(1);
                self.consecutive_unavailable = 0;
                self.peak_bytes = Some(self.peak_bytes.map_or(bytes, |peak| peak.max(bytes)));
                (bytes > OBSERVED_FOOTPRINT_LIMIT_BYTES)
                    .then_some(MonitorFailure::ObservedFootprintLimit)
            }
            None => {
                self.unavailable_count = self.unavailable_count.saturating_add(1);
                self.consecutive_unavailable = self.consecutive_unavailable.saturating_add(1);
                (self.consecutive_unavailable >= UNAVAILABLE_SAMPLE_LIMIT)
                    .then_some(MonitorFailure::ResourceMonitorUnavailable)
            }
        }
    }

    pub fn successful_samples(&self) -> u32 {
        self.sample_count
    }

    pub fn finish(self) -> ResourceObservation {
        ResourceObservation {
            elapsed_milliseconds: Some(
                self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
            ),
            sample_count: self.sample_count,
            unavailable_sample_count: self.unavailable_count,
            peak_observed_physical_footprint_bytes: self.peak_bytes,
            sample_interval_milliseconds: SAMPLE_INTERVAL.as_millis() as u64,
            observed_footprint_limit_bytes: OBSERVED_FOOTPRINT_LIMIT_BYTES,
        }
    }
}

#[cfg(target_os = "macos")]
fn sampled_physical_footprint(pid: i32) -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::uninit();
    let result =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, usage.as_mut_ptr().cast()) };
    if result != 0 {
        return None;
    }
    Some(unsafe { usage.assume_init() }.ri_phys_footprint)
}
