import { invoke } from "@tauri-apps/api/core";
import { aiConnectionButtonState, aiConnectionRows } from "./aiConnectionView";
import { dispatchAToolsSettings, type AToolsSettings, type AiProvider } from "./settings";
import {
  aiProviderOptions,
  hasTauriRuntime,
  type AccessibilityPermissionStatus,
  type DevtoolsOpenResult,
} from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import type { AiConnectionTestResult, PluginProviderDescriptor } from "./types";

export function createSettingsAiController(
  s: SettingsPanelState,
  deps: {
    persistSoon: () => void;
    currentSettings: () => AToolsSettings;
    saveSettingsImmediately: (settings: AToolsSettings) => Promise<void>;
  },
) {
  const { persistSoon, currentSettings, saveSettingsImmediately } = deps;

  async function refreshAccessibilityPermission() {
    s.accessibilityPermissionMessage = "";
    if (!hasTauriRuntime()) {
      s.accessibilityPermission = null;
      s.accessibilityPermissionMessage = "桌面应用中可检测辅助功能权限";
      return;
    }
    s.accessibilityPermissionBusy = true;
    try {
      s.accessibilityPermission = await invoke<AccessibilityPermissionStatus>("get_accessibility_permission_status");
    } catch (error) {
      s.accessibilityPermissionMessage = String(error);
    } finally {
      s.accessibilityPermissionBusy = false;
    }
  }

  async function openAccessibilityPermissionSettings() {
    if (!hasTauriRuntime()) {
      s.accessibilityPermissionMessage = "桌面应用中可打开系统设置";
      return;
    }
    s.accessibilityPermissionBusy = true;
    s.accessibilityPermissionMessage = "";
    try {
      s.accessibilityPermission = await invoke<AccessibilityPermissionStatus>("open_accessibility_settings");
      s.accessibilityPermissionMessage = "已打开系统辅助功能设置，授权后请重新检测";
    } catch (error) {
      s.accessibilityPermissionMessage = String(error);
    } finally {
      s.accessibilityPermissionBusy = false;
    }
  }

  async function refreshPluginProviders() {
    s.pluginProvidersStatus = "";
    if (!hasTauriRuntime()) {
      s.pluginProviders = [];
      s.pluginProvidersStatus = "桌面应用中可管理翻译与 OCR 提供商";
      return;
    }
    s.pluginProvidersLoading = true;
    try {
      s.pluginProviders = await invoke<PluginProviderDescriptor[]>("list_plugin_providers", { providerType: null });
      s.pluginProvidersStatus = `已读取 ${s.pluginProviders.length} 个提供商`;
    } catch (error) {
      s.pluginProvidersStatus = String(error);
    } finally {
      s.pluginProvidersLoading = false;
    }
  }

  async function setDefaultPluginProvider(provider: PluginProviderDescriptor) {
    if (!hasTauriRuntime() || !provider.enabled) return;
    s.busyProviderId = provider.id;
    s.pluginProvidersStatus = "";
    try {
      await invoke<PluginProviderDescriptor>("set_default_plugin_provider", {
        providerType: provider.type,
        providerId: provider.id,
      });
      await refreshPluginProviders();
      s.pluginProvidersStatus = `已将 ${provider.label} 设为默认${provider.type === "translation" ? "翻译" : " OCR"}提供商`;
    } catch (error) {
      s.pluginProvidersStatus = String(error);
    } finally {
      s.busyProviderId = "";
    }
  }

  function providersForType(providerType: PluginProviderDescriptor["type"]) {
    return s.pluginProviders.filter((provider) => provider.type === providerType);
  }

  function confirmSettingsAction(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "danger";
  }) {
    if (s.settingsConfirmRequest) {
      s.settingsConfirmRequest.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      s.settingsConfirmRequest = {
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? "确认",
        cancelLabel: options.cancelLabel ?? "取消",
        tone: options.tone ?? "danger",
        resolve,
      };
    });
  }

  function resolveSettingsConfirm(confirmed: boolean) {
    const request = s.settingsConfirmRequest;
    if (!request) return;
    s.settingsConfirmRequest = null;
    request.resolve(confirmed);
  }

  async function setFloatingBallVisible() {
    s.floatingBallStatus = "";
    s.dirty = true;
    const preview = !hasTauriRuntime();
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
    } catch {
      return;
    }
    dispatchAToolsSettings(settings);
    s.floatingBallStatus = preview
      ? "浏览器预览模式不会创建悬浮球窗口"
      : settings.floatingBallEnabled ? "悬浮球已显示" : "悬浮球已隐藏";
  }

  function persistFloatingBallChange(event: Event) {
    event.stopPropagation();
    s.floatingBallEnabled = (event.currentTarget as HTMLInputElement).checked;
    void setFloatingBallVisible().catch(() => {});
  }

  async function setSuperPanelVisible() {
    s.superPanelStatus = "";
    s.dirty = true;
    const preview = !hasTauriRuntime();
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
    } catch {
      return;
    }
    dispatchAToolsSettings(settings);
    s.superPanelStatus = preview
      ? "浏览器预览模式不会创建超级面板窗口"
      : settings.superPanelEnabled ? "超级面板已显示" : "超级面板已隐藏";
  }

  function persistSuperPanelChange(event: Event) {
    event.stopPropagation();
    s.superPanelEnabled = (event.currentTarget as HTMLInputElement).checked;
    void setSuperPanelVisible().catch(() => {});
  }

  async function openDevtoolsForWindow(windowLabel = "main") {
    s.devtoolsStatus = "";
    if (!hasTauriRuntime()) {
      s.devtoolsStatus = "浏览器预览模式无法打开 Tauri DevTools";
      return;
    }
    try {
      const result = await invoke<DevtoolsOpenResult>("open_devtools_for_window", {
        settings: currentSettings(),
        windowLabel,
      });
      s.devtoolsStatus = result.detail;
    } catch (error) {
      s.devtoolsStatus = String(error);
    }
  }

  function clearAiConnectionResult() {
    s.aiLastConnection = null;
    s.aiConnectionStatus = "";
  }

  function updateAiProvider(value: AiProvider) {
    s.aiProvider = value;
    if (s.aiProvider === "disabled") {
      s.aiUseForAgent = false;
    }
    clearAiConnectionResult();
    persistSoon();
  }

  function aiProviderLabel() {
    return aiProviderOptions.find((option) => option.value === s.aiProvider)?.label ?? "关闭";
  }

  function aiBaseUrlPlaceholder() {
    if (s.aiProvider === "openai") return "https://api.openai.com/v1";
    if (s.aiProvider === "local") return "http://127.0.0.1:11434/v1";
    return "https://api.example.com/v1";
  }

  function aiConfigReady() {
    if (s.aiProvider === "disabled") return false;
    if (!s.aiDefaultModel.trim()) return false;
    if (s.aiProvider === "local") return Boolean(s.aiBaseUrl.trim());
    return Boolean(s.aiBaseUrl.trim() && s.aiApiKey.trim());
  }

  function persistAiConfigChange() {
    clearAiConnectionResult();
    persistSoon();
  }

  function aiConnectionButton() {
    return aiConnectionButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      provider: s.aiProvider,
      configReady: aiConfigReady(),
      testing: s.aiTestingConnection,
    });
  }

  function aiConnectionResultRows() {
    return aiConnectionRows(s.aiLastConnection);
  }

  async function testAiConnection() {
    const button = aiConnectionButton();
    if (button.disabled) {
      s.aiConnectionStatus = button.reason;
      return;
    }

    s.aiTestingConnection = true;
    s.aiConnectionStatus = "正在读取模型列表...";
    s.aiLastConnection = null;
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const result = await invoke<AiConnectionTestResult>("test_ai_connection", { settings });
      s.aiLastConnection = result;
      s.aiConnectionStatus = result.model_found
        ? `连接正常，已找到 ${result.model}`
        : `连接正常，但 ${result.model} 未出现在模型列表`;
    } catch (error) {
      s.aiLastConnection = null;
      s.aiConnectionStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.aiTestingConnection = false;
    }
  }

  return {
    refreshAccessibilityPermission,
    openAccessibilityPermissionSettings,
    refreshPluginProviders,
    setDefaultPluginProvider,
    providersForType,
    confirmSettingsAction,
    resolveSettingsConfirm,
    setFloatingBallVisible,
    persistFloatingBallChange,
    setSuperPanelVisible,
    persistSuperPanelChange,
    openDevtoolsForWindow,
    clearAiConnectionResult,
    updateAiProvider,
    aiProviderLabel,
    aiBaseUrlPlaceholder,
    aiConfigReady,
    persistAiConfigChange,
    aiConnectionButton,
    aiConnectionResultRows,
    testAiConnection,
  };
}
