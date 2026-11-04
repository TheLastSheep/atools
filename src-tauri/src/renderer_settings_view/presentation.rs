use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(feature = "legacy-node-smoke")]
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[cfg(feature = "legacy-node-smoke")]
use crate::renderer_desktop_smoke::profile::Profile;

const SESSION_FOCUS_REQUESTS: u64 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FocusPhase {
    ChildInitialFocus,
    SessionFocus,
    ValueEcho,
    ChildDelivery,
}

#[derive(Default)]
struct HiddenSmokePolicy {
    suppressed_focus_requests: AtomicU64,
    #[cfg(feature = "legacy-node-smoke")]
    launch_return_scope: Option<LaunchReturnScope>,
}

#[cfg(feature = "legacy-node-smoke")]
#[derive(Clone, Debug, Eq, PartialEq)]
struct LaunchReturnScope {
    run_id: String,
    root: std::path::PathBuf,
}

#[cfg(feature = "legacy-node-smoke")]
impl LaunchReturnScope {
    fn validate(app: &AppHandle, profile: &Profile) -> Result<Self, String> {
        profile.validate_settings_child_fixture()?;
        if app.config().identifier != profile.expected_identifier() {
            return Err(
                "Hidden launch-return presentation requires its exact fixture identifier".into(),
            );
        }
        Ok(Self {
            run_id: profile.run_id.clone(),
            root: profile.root.clone(),
        })
    }
}

impl HiddenSmokePolicy {
    fn suppress(&self, phase: FocusPhase) -> bool {
        let request_count = focus_request_count(phase);
        self.suppressed_focus_requests
            .fetch_add(request_count, Ordering::Relaxed);
        true
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    fn suppressed_focus_requests(&self) -> u64 {
        self.suppressed_focus_requests.load(Ordering::Relaxed)
    }

    #[cfg(feature = "legacy-node-smoke")]
    fn authorizes_launch_return(&self, scope: &LaunchReturnScope) -> bool {
        self.launch_return_scope.as_ref() == Some(scope)
    }
}

/// Installs the hidden-presentation policy for the validated settings-input fixture only.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn install_hidden_smoke(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let expected_identifier = settings_input_identifier(run_id).ok_or_else(|| {
        "Settings input smoke run ID must be 32 lowercase hexadecimal characters".to_owned()
    })?;
    if app.config().identifier != expected_identifier {
        return Err("Hidden settings presentation requires its exact fixture identifier".into());
    }
    install_policy(app, HiddenSmokePolicy::default())
}

/// The height fixture must own its managed profile and verified formal source.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn install_settings_height_hidden(
    app: &AppHandle,
    profile: &Profile,
) -> Result<(), String> {
    profile.validate_settings_height_fixture()?;
    crate::renderer_desktop_smoke::settings_height::validate(app)?;
    install_policy(app, HiddenSmokePolicy::default())
}

/// Authorizes only the owned launch-return/local-shortcut/settings-child fixture.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn install_launch_return_hidden_smoke(
    app: &AppHandle,
    profile: &Profile,
) -> Result<(), String> {
    let scope = LaunchReturnScope::validate(app, profile)?;
    if app.try_state::<HiddenSmokePolicy>().is_some() {
        return Err("Hidden settings presentation policy is already installed".into());
    }
    super::native_drop::install_fixture_registry(app)?;
    install_policy(
        app,
        HiddenSmokePolicy {
            launch_return_scope: Some(scope),
            ..HiddenSmokePolicy::default()
        },
    )
}

#[cfg(feature = "legacy-node-smoke")]
pub(super) fn authorize_launch_return_fixture(
    app: &AppHandle,
    profile: &Profile,
) -> Result<(), String> {
    let scope = LaunchReturnScope::validate(app, profile)?;
    let policy = app
        .try_state::<HiddenSmokePolicy>()
        .ok_or_else(|| "Hidden launch-return presentation policy is missing".to_owned())?;
    if !policy.authorizes_launch_return(&scope) {
        return Err("Hidden launch-return presentation scope does not match".into());
    }
    Ok(())
}

#[cfg(feature = "legacy-node-smoke")]
fn install_policy(app: &AppHandle, policy: HiddenSmokePolicy) -> Result<(), String> {
    if app.try_state::<HiddenSmokePolicy>().is_some() {
        return Err("Hidden settings presentation policy is already installed".into());
    }
    if !app.manage(policy) {
        return Err("Hidden settings presentation policy could not be installed".into());
    }
    Ok(())
}

/// Allows focus in production and suppresses only the settings focus phases used by the fixture.
pub(crate) fn allow_focus(app: &AppHandle, phase: FocusPhase) -> bool {
    allow_focus_with_policy(app.try_state::<HiddenSmokePolicy>().as_deref(), phase)
}

#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn snapshot(app: &AppHandle) -> Value {
    let policy = app.try_state::<HiddenSmokePolicy>();
    json!({
        "hiddenSmoke": policy.is_some(),
        "suppressedFocusRequests": policy.map_or(0, |policy| policy.suppressed_focus_requests()),
    })
}

#[cfg(any(feature = "legacy-node-smoke", test))]
fn settings_input_identifier(run_id: &str) -> Option<String> {
    let uuid = uuid::Uuid::parse_str(run_id).ok()?;
    if uuid.simple().to_string() != run_id {
        return None;
    }
    Some(format!("dev.atools.renderer-settings-input.{run_id}"))
}

fn allow_focus_with_policy(policy: Option<&HiddenSmokePolicy>, phase: FocusPhase) -> bool {
    policy.map_or(true, |policy| !policy.suppress(phase))
}

fn focus_request_count(phase: FocusPhase) -> u64 {
    match phase {
        FocusPhase::ChildInitialFocus => 1,
        FocusPhase::SessionFocus => SESSION_FOCUS_REQUESTS,
        FocusPhase::ValueEcho | FocusPhase::ChildDelivery => 1,
    }
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;

/// Feature-only owned About journey, not a label/environment grant.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn install_owned_about_hidden(app: &AppHandle) -> Result<(), String> {
    if !crate::renderer_desktop_smoke::updater_journey::about_authorized(app) {
        return Err("Owned About fixture capability is missing".into());
    }
    install_policy(app, HiddenSmokePolicy::default())
}
