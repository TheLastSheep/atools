use super::{map_error, production_scope_matches};
use crate::general_settings_runtime::login_items::{
    APPROVAL_REQUIRED, CONFLICT, LEGACY_CONFIGURATION, RECOVERY_FAILED, UNAVAILABLE, UNSUPPORTED,
};

#[test]
fn production_legacy_scope_requires_an_exact_product_identifier_and_matching_bundle() {
    for identifier in ["dev.atools.desktop", "com.atools.desktop"] {
        assert!(production_scope_matches(identifier, true));
        assert!(!production_scope_matches(identifier, false));
    }

    for identifier in [
        "dev.atools.renderer-smoke.0123456789abcdef0123456789abcdef",
        "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
        "dev.atools.desktop.test",
        "com.atools.desktop.helper",
        "other.desktop",
    ] {
        assert!(!production_scope_matches(identifier, true), "{identifier}");
    }
}

#[test]
fn legacy_backend_errors_keep_only_the_fixed_public_codes() {
    for code in [
        APPROVAL_REQUIRED,
        CONFLICT,
        LEGACY_CONFIGURATION,
        RECOVERY_FAILED,
        UNSUPPORTED,
        UNAVAILABLE,
    ] {
        assert_eq!(map_error(code), code);
    }
    assert_eq!(map_error("private path or diagnostic"), UNAVAILABLE);
}
