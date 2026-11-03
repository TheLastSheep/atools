import { join } from "node:path";
import { readCommandAliasesReport } from "./ztools-command-aliases-report.mjs";
import { readMainHotkeyReport } from "./ztools-main-hotkey-report.mjs";
import { readTrayVisibilityReport } from "./ztools-tray-visibility-report.mjs";
import { readWindowOpacityReport } from "./ztools-window-opacity-report.mjs";
import { GENERAL_POLICIES_REPORT_FILENAME, readGeneralPoliciesReport } from "./ztools-general-policies-report.mjs";
import { LAUNCH_AT_LOGIN_REPORT_FILENAME, readLaunchAtLoginReport } from "./ztools-launch-at-login-report.mjs";
import { LOGIN_CROSS_ENTRY_REPORT_FILENAME, readLoginCrossEntryReport } from "./ztools-login-cross-entry-report.mjs";

const FINAL_REPORT_NAMES = Object.freeze([
  "commandAliases", "windowOpacity", "trayVisibility", "mainHotkey", "generalPolicies", "launchAtLogin", "loginCrossEntry",
]);

function emptyFinalReport() {
  return {
    exists: false, valid: false, passed: false, errors: [], summary: null,
    ownerMatchesNativeReport: null, nativeCaseSucceeded: false, exception: null,
  };
}

export function emptySettingsInputFinalReports() {
  return Object.fromEntries(FINAL_REPORT_NAMES.map(name => [name, emptyFinalReport()]));
}

export function settingsInputFinalReportsPassed(reports) {
  return FINAL_REPORT_NAMES.every(name => {
    const report = reports?.[name];
    return report?.exists === true && report.valid === true && report.passed === true
      && report.ownerMatchesNativeReport === true && report.nativeCaseSucceeded === true;
  });
}

/** Collects the fixed late-stage reports under the already validated Native case owner. */
export async function readSettingsInputFinalReports(runDirectory, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded, nativeProcessTerminal = false) {
  const [commandAliases, windowOpacity, trayVisibility, mainHotkey, generalPolicies, launchAtLogin, loginCrossEntry] = await Promise.all([
    readCommandAliasesReport(join(runDirectory, "native-command-aliases-report.json"), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readWindowOpacityReport(join(runDirectory, "native-window-opacity-report.json"), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readTrayVisibilityReport(join(runDirectory, "native-tray-visibility-report.json"), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readMainHotkeyReport(join(runDirectory, "native-main-hotkey-report.json"), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readGeneralPoliciesReport(join(runDirectory, GENERAL_POLICIES_REPORT_FILENAME), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readLaunchAtLoginReport(join(runDirectory, LAUNCH_AT_LOGIN_REPORT_FILENAME), expectedOwner,
      nativeOwnerMatches, nativeCaseSucceeded),
    readLoginCrossEntryReport(join(runDirectory, LOGIN_CROSS_ENTRY_REPORT_FILENAME), expectedOwner, {
      nativeOwnerMatches,
      nativeProcessTerminal,
      nativeProcessSucceeded: nativeCaseSucceeded,
      nativeCaseSucceeded,
    }),
  ]);
  return {
    commandAliases, windowOpacity, trayVisibility, mainHotkey, generalPolicies, launchAtLogin,
    loginCrossEntry: {
      ...loginCrossEntry,
      ownerMatchesNativeReport: nativeOwnerMatches === true,
      nativeCaseSucceeded: nativeCaseSucceeded === true,
    },
  };
}
