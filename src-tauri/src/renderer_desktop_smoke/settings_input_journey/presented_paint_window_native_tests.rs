#[test]
fn accepts_only_canonical_lowercase_v4_run_ids() {
    assert!(super::valid_run_id("550e8400e29b41d4a716446655440000"));
    assert!(!super::valid_run_id("550e8400e29b11d4a716446655440000"));
    assert!(!super::valid_run_id("550E8400E29B41D4A716446655440000"));
    assert!(!super::valid_run_id("not-a-run-id"));
}
