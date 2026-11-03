#[cfg(target_os = "macos")]
use super::pin_node;
#[cfg(target_os = "macos")]
use std::{env, path::PathBuf, sync::atomic::AtomicBool};

#[cfg(target_os = "macos")]
const EXPECTED_BYTES: u64 = 112_925_600;
#[cfg(target_os = "macos")]
const EXPECTED_NODE_SHA256: &str =
    "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b";
#[cfg(target_os = "macos")]
const EXPECTED_FINGERPRINT_SHA256: &str =
    "7ebb9553efb80572d11797ab8a2bb249734bc34f1d54d82efee6a8d6f1579985";
#[cfg(target_os = "macos")]
const MEASURED_ROUNDS: usize = 7;

/// Explicit, ignored benchmark for the pinned Node binary. The file path is the
/// only caller-provided value; byte count and both digests are fixed here.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "reads and hashes the pinned 112.9MB Node binary; run only in a serial benchmark slot"]
fn fixed_node_fingerprint_dev_profile_benchmark() {
    let path = env::var_os("ATOOLS_NODE_FINGERPRINT_BENCH_PATH")
        .map(PathBuf::from)
        .expect("set ATOOLS_NODE_FINGERPRINT_BENCH_PATH to the pinned Node 22 executable");
    assert!(path.is_absolute(), "benchmark input path must be absolute");

    let target = atools_plugin::source_build::current_build_target()
        .unwrap_or_else(|_| panic!("fixed benchmark target is unavailable"));
    let cancelled = AtomicBool::new(false);
    let run = || {
        let pin = pin_node(&path, &target, &cancelled)
            .unwrap_or_else(|code| panic!("fixed Node fingerprint failed: {code}"));
        assert_eq!(pin.bytes, EXPECTED_BYTES, "pinned Node byte count changed");
        assert_eq!(
            pin.sha256, EXPECTED_NODE_SHA256,
            "pinned Node content digest changed"
        );
        assert_eq!(
            pin.fingerprint_sha256, EXPECTED_FINGERPRINT_SHA256,
            "target/protocol-bound fingerprint changed"
        );
        pin.elapsed_ms
    };

    let warmup_ms = run();
    let samples_ms: Vec<u64> = (0..MEASURED_ROUNDS).map(|_| run()).collect();
    let mut sorted = samples_ms.clone();
    sorted.sort_unstable();
    let report = serde_json::json!({
        "schema": "atools.node-fingerprint-benchmark.v1",
        "inputBytes": EXPECTED_BYTES,
        "nodeSha256": EXPECTED_NODE_SHA256,
        "target": { "os": target.os, "cpu": target.cpu },
        "toolchainFingerprintSha256": EXPECTED_FINGERPRINT_SHA256,
        "warmupElapsedMs": warmup_ms,
        "measuredSamplesElapsedMs": samples_ms,
        "medianElapsedMs": sorted[MEASURED_ROUNDS / 2],
        "minElapsedMs": sorted[0],
        "maxElapsedMs": sorted[MEASURED_ROUNDS - 1],
        "measurementScope": "explicit-dev-profile-hash-only; not cold-start, release, or application latency"
    });
    println!(
        "{}",
        serde_json::to_string(&report).expect("bounded benchmark JSON")
    );
}
