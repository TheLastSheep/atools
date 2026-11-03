use serde::{Deserialize, Serialize};

/// A user choice, independent of any platform-specific filesystem adapter.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyLoginChoice {
    TurnOff,
    Migrate,
}

impl LegacyLoginChoice {
    pub(crate) fn target_enabled(self) -> bool {
        self == Self::Migrate
    }
}

/// Only facts needed to select an action; paths and legacy content remain private.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyLoginInspection {
    pub(crate) modern_enabled: bool,
    pub(crate) revision: String,
}

pub(crate) fn valid_legacy_revision(revision: &str) -> bool {
    revision.len() == 64
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_value, json, to_value};

    #[test]
    fn wire_choices_are_explicit_and_inspection_has_no_path_fields() {
        assert_eq!(
            from_value::<LegacyLoginChoice>(json!("turnOff")).unwrap(),
            LegacyLoginChoice::TurnOff
        );
        assert_eq!(
            from_value::<LegacyLoginChoice>(json!("migrate")).unwrap(),
            LegacyLoginChoice::Migrate
        );
        for value in [
            json!("disable"),
            json!("Migrate"),
            json!(true),
            json!({"migrate": true}),
        ] {
            assert!(from_value::<LegacyLoginChoice>(value).is_err());
        }
        assert_eq!(
            to_value(LegacyLoginInspection {
                modern_enabled: true,
                revision: "a".repeat(64)
            })
            .unwrap(),
            json!({"modernEnabled": true, "revision": "a".repeat(64)})
        );
    }

    #[test]
    fn revisions_are_exact_lowercase_digests() {
        assert!(valid_legacy_revision(&"0123456789abcdef".repeat(4)));
        for value in [
            "",
            &"a".repeat(63),
            &"a".repeat(65),
            &"A".repeat(64),
            &"g".repeat(64),
        ] {
            assert!(!valid_legacy_revision(value));
        }
    }
}
