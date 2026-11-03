use super::*;
use serde_json::json;

#[test]
fn raw_presence_differs_from_the_ui_projection_and_preserves_fractional_values() {
    assert_eq!(raw_default(None).unwrap(), 542.0);
    assert_eq!(raw_default(Some("{}")).unwrap(), 542.0);
    for height in [200.0, 200.5, 541.0, 2001.0] {
        let raw = json!({"windowDefaultHeight": height}).to_string();
        assert_eq!(raw_default(Some(&raw)).unwrap(), height);
        let projected =
            super::super::preferences::project_general_settings(Some(&raw), "").unwrap();
        assert_eq!(projected["windowDefaultHeight"].as_f64().unwrap(), height);
    }
    assert_eq!(
        super::super::preferences::project_general_settings(None, "").unwrap()
            ["windowDefaultHeight"],
        541
    );
    for raw in [
        r#"{"windowDefaultHeight":null}"#,
        r#"{"windowDefaultHeight":199}"#,
        "invalid",
    ] {
        assert!(raw_default(Some(raw)).is_err());
    }
}

#[test]
fn requested_cache_commits_only_current_ready_candidate_not_clipped_actual_or_new_default() {
    let mut cache = HeightCache::default();
    assert_eq!(cache.stage("first", "bundle", 2001.0), 2001.0);
    assert!(!cache.confirm("late", "bundle"));
    assert!(cache.confirm("first", "bundle"));
    // Workarea clipping is not an input to this cache. A new General default/reset does not replace it.
    assert_eq!(cache.stage("second", "bundle", 541.0), 2001.0);
    assert_eq!(cache.stage("replacement", "bundle", 200.5), 2001.0);
    assert!(!cache.confirm("second", "bundle"));
    assert!(cache.confirm("replacement", "bundle"));
    // Failed opening for another bundle never commits; old confirmed bundle remains usable.
    assert_eq!(cache.stage("failed", "different", 200.5), 200.5);
    assert!(!cache.confirm("failed", "bundle"));
    assert_eq!(cache.stage("third", "bundle", 542.0), 2001.0);
    assert_eq!(cache.stage("new", "different", 200.5), 200.5);
    assert!(cache.confirm("new", "different"));
    assert_eq!(cache.stage("oldbundle", "bundle", 541.0), 541.0);
    assert_eq!(
        HeightCache::default().stage("fresh", "bundle", 541.0),
        541.0
    );
}
