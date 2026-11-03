const OBSERVATION_MODE = "observe";
const EXPECTED_BUNDLE_PREFIX = "dev.atools.fixture.dialog.";
const EXPECTED_BUNDLE_PATTERN = /^dev\.atools\.fixture\.dialog\.[0-9a-f]{32}$/;

/**
 * Builds the only environment additions allowed for the finite panel activation observer.
 * Ambient values for these private switches are always stripped from the fixture environment.
 */
export function activationObservationEnvironment({
  environment = {},
  requestedMode,
  nativeUiInput = false,
  stagedBundleId,
} = {}) {
  const nextEnvironment = { ...environment };
  delete nextEnvironment.ATOOLS_PANEL_ACTIVATION_OBSERVATION;
  delete nextEnvironment.ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID;

  if (requestedMode === undefined) {
    return { enabled: false, environment: nextEnvironment, reportScope: null };
  }
  if (requestedMode !== OBSERVATION_MODE) {
    throw new Error("Activation observation accepts only the exact observe mode");
  }
  if (nativeUiInput !== true) {
    throw new Error("Activation observation requires the registered native editor fixture mode");
  }
  if (typeof stagedBundleId !== "string" || !EXPECTED_BUNDLE_PATTERN.test(stagedBundleId)) {
    throw new Error(`Activation observation requires the exact staged bundle identity prefix ${EXPECTED_BUNDLE_PREFIX}`);
  }

  nextEnvironment.ATOOLS_PANEL_ACTIVATION_OBSERVATION = OBSERVATION_MODE;
  nextEnvironment.ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID = stagedBundleId;
  return {
    enabled: true,
    environment: nextEnvironment,
    reportScope: "Read-only window activation observation only; not editor input, formatting, diagnostics, recovery, or plugin UX acceptance",
  };
}
