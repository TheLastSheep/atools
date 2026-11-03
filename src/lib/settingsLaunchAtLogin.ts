import { invoke } from "@tauri-apps/api/core";
import {
  createLaunchAtLoginController,
  type LaunchAtLoginPort,
  type LaunchAtLoginState,
} from "../../packages/ztools-settings/src/launchAtLoginController";

export type {
  LaunchAtLoginPort as SettingsLaunchAtLoginPort,
  LaunchAtLoginState as SettingsLaunchAtLoginState,
  LaunchAtLoginPhase as SettingsLaunchAtLoginPhase,
  LaunchAtLoginChoice,
} from "../../packages/ztools-settings/src/launchAtLoginController";

export type SettingsLaunchAtLoginChange = Readonly<{ expected: boolean; enabled: boolean }>;

export const nativeSettingsLaunchAtLoginPort: LaunchAtLoginPort = {
  read: () => invoke<unknown>("read_launch_at_login"),
  change: request => invoke<unknown>("change_launch_at_login", request),
  inspectLegacy: () => invoke<unknown>("inspect_legacy_launch_at_login"),
  resolveLegacy: request => invoke<unknown>("resolve_legacy_launch_at_login", request),
};

export function createSettingsLaunchAtLoginController(
  port: LaunchAtLoginPort = nativeSettingsLaunchAtLoginPort,
) {
  return createLaunchAtLoginController(port);
}

export type { LaunchAtLoginState };
