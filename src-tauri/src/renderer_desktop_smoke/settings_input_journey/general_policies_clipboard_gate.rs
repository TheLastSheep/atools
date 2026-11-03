use serde_json::Value;

pub(super) fn passed(observations: &Value) -> bool {
    clipboard_passed(&observations["clipboard"])
}

fn clipboard_passed(value: &Value) -> bool {
    let initial_days = value["initialUiDays"].as_u64();
    if initial_days != Some(value["initialStoredDays"].as_u64().unwrap_or(180)) {
        return false;
    }
    let snapshots = |stage: &Value,
                     before_counts: (u64, u64),
                     before_facts: &[(&str, bool)],
                     after_counts: (u64, u64),
                     after_facts: &[(&str, bool)],
                     days: u64| {
        stage["uiDays"].as_u64() == Some(days)
            && stage["storedDays"].as_u64() == Some(days)
            && stage["resetDispatched"].as_bool() == Some(false)
            && stage["captureSucceeded"].as_bool() == Some(true)
            && snapshot_matches(&stage["beforeCapture"], before_counts, before_facts)
            && snapshot_matches(&stage["afterCapture"], after_counts, after_facts)
    };
    let before_30 = &[
        ("expiredUnpinnedPresent", true),
        ("recentUnpinnedPresent", true),
        ("expiredPinnedPresent", true),
        ("legacyExpiredPresent", true),
        ("legacyRecentPresent", true),
        ("reset100DayPresent", false),
        ("legacyReset100DayPresent", false),
    ];
    let after_30 = &[
        ("expiredUnpinnedPresent", false),
        ("recentUnpinnedPresent", true),
        ("expiredPinnedPresent", true),
        ("legacyExpiredPresent", false),
        ("legacyRecentPresent", true),
        ("reset100DayPresent", false),
        ("legacyReset100DayPresent", false),
    ];
    let after_1 = &[
        ("expiredUnpinnedPresent", false),
        ("recentUnpinnedPresent", false),
        ("expiredPinnedPresent", true),
        ("legacyExpiredPresent", false),
        ("legacyRecentPresent", false),
        ("reset100DayPresent", false),
        ("legacyReset100DayPresent", false),
    ];
    let counts = (3, 2);
    if !snapshots(&value["at30"], counts, before_30, counts, after_30, 30)
        || !snapshots(&value["at1"], counts, after_30, counts, after_1, 1)
    {
        return false;
    }
    let reset = &value["afterReset180"];
    let reset_before = snapshot_matches(&reset["beforeReset"], counts, after_1);
    let reset_after = snapshot_matches(&reset["afterReset"], counts, after_1);
    let reset_seeded = &[
        ("expiredUnpinnedPresent", false),
        ("recentUnpinnedPresent", false),
        ("expiredPinnedPresent", true),
        ("legacyExpiredPresent", false),
        ("legacyRecentPresent", false),
        ("reset100DayPresent", true),
        ("legacyReset100DayPresent", true),
    ];
    reset["uiDays"].as_u64() == Some(180)
        && reset["storedDays"].as_u64() == Some(180)
        && reset["resetDispatched"].as_bool() == Some(true)
        && reset_before
        && reset_after
        && reset["beforeReset"] == reset["afterReset"]
        && snapshot_matches(&reset["beforeCapture"], (4, 3), reset_seeded)
        && reset["captureSucceeded"].as_bool() == Some(true)
        && snapshot_matches(&reset["afterCapture"], (5, 4), reset_seeded)
}

fn snapshot_matches(value: &Value, counts: (u64, u64), facts: &[(&str, bool)]) -> bool {
    value["pasteboardCount"].as_u64() == Some(counts.0)
        && value["legacyCount"].as_u64() == Some(counts.1)
        && facts
            .iter()
            .all(|(key, expected)| value[*key].as_bool() == Some(*expected))
}
