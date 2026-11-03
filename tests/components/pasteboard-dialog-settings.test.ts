import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PasteboardDialog from "../../src/components/PasteboardDialog.svelte";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: tauri.invoke,
}));

type NativeRecord = Record<string, unknown>;
type NativeSaveRequest = {
  expected: { raw: string | null };
  changes: NativeRecord;
  applyNative: boolean;
};
type SaveAttempt = { expectedRaw: string | null; changes: NativeRecord; applyNative: boolean };

let currentRaw: string | null;
let readFailure: string | null;
let deferReads: boolean;
let readReplies: Array<(raw: string | null) => void>;
let deferredSave: (() => void) | null;
let deferSave: boolean;
let saveAttempts: SaveAttempt[];
let committedWrites: number;
let repositionFailures: number;
let repositionCalls: number;
let notificationDelivered: boolean;

function recordFromRaw(raw: string | null): NativeRecord {
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture settings are not a record");
  return parsed as NativeRecord;
}

function nativeInvoke(command: string, rawArgs?: Record<string, unknown>): Promise<unknown> | unknown {
  if (command === "get_setting") {
    if (rawArgs?.key !== "settings-general") throw new Error("unexpected settings read arguments");
    if (readFailure) throw new Error(readFailure);
    if (deferReads) return new Promise<string | null>(resolve => readReplies.push(resolve));
    return currentRaw;
  }
  if (command === "save_general_settings") {
    const request = rawArgs as unknown as NativeSaveRequest;
    if (!request?.expected || !request.changes || request.applyNative !== false) {
      throw new Error("unexpected settings save request");
    }
    saveAttempts.push({
      expectedRaw: request.expected.raw,
      changes: JSON.parse(JSON.stringify(request.changes)) as NativeRecord,
      applyNative: request.applyNative,
    });
    const commit = () => {
      if (request.expected.raw !== currentRaw) throw new Error("native settings CAS conflict");
      const next = { ...recordFromRaw(currentRaw), ...request.changes };
      currentRaw = JSON.stringify(next);
      committedWrites += 1;
      return {
        version: 1,
        raw: currentRaw,
        notificationDelivered,
        effectsApplied: false,
        aiInvalidated: false,
      };
    };
    if (deferSave) {
      return new Promise((resolve, reject) => {
        deferredSave = () => {
          try {
            resolve(commit());
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    return commit();
  }
  if (command === "reposition_pasteboard_shelf_window") {
    repositionCalls += 1;
    if (repositionFailures > 0) {
      repositionFailures -= 1;
      throw new Error("fixture layout failure");
    }
    return undefined;
  }
  if (command === "hide_pasteboard_dialog_window") return undefined;
  throw new Error(`unexpected native command: ${command}`);
}

function nativeRecord(): NativeRecord {
  return recordFromRaw(currentRaw);
}

function nativeReadCount(): number {
  return tauri.invoke.mock.calls.filter(([command]) => command === "get_setting").length;
}

function setDialogMode(mode: "settings" | "preview") {
  window.history.replaceState(null, "", `#/pasteboard?mode=${mode}`);
  window.dispatchEvent(new Event("hashchange"));
}

function renderSettingsDialog() {
  window.history.replaceState(null, "", "#/pasteboard?mode=settings");
  return render(PasteboardDialog);
}

async function waitUntilSettingsReady() {
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" }).hasAttribute("disabled")).toBe(false));
}

beforeEach(() => {
  currentRaw = JSON.stringify({
    theme: "dark",
    futureSetting: { retained: true },
    pasteboardDockEdge: "bottom",
    pasteboardCompact: false,
    clipboardRetentionDays: 90,
    pasteboardAttachmentBudgetBytes: 1_073_741_824,
    pasteboardExcludeSensitiveContent: true,
  });
  readFailure = null;
  deferReads = false;
  readReplies = [];
  deferredSave = null;
  deferSave = false;
  saveAttempts = [];
  committedWrites = 0;
  repositionFailures = 0;
  repositionCalls = 0;
  notificationDelivered = true;
  tauri.invoke.mockReset().mockImplementation(nativeInvoke);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: tauri.invoke },
  });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#/");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.clear();
});

it("uses the opened CAS snapshot, preserves a concurrent theme update, and sends only clipboard keys after reload", async () => {
  const initialRaw = currentRaw;
  renderSettingsDialog();
  await waitFor(() => expect(nativeReadCount()).toBe(1));
  await waitUntilSettingsReady();

  currentRaw = JSON.stringify({
    ...nativeRecord(),
    theme: "light",
    futureSetting: { retained: "updated elsewhere" },
    pasteboardCompact: true,
  });
  const externalRaw = currentRaw;
  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(await screen.findByText(/保存结果未确认/)).toBeTruthy();
  expect(screen.getByText("保存状态未确认")).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存设置" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
  expect(nativeRecord()).toMatchObject({ theme: "light", futureSetting: { retained: "updated elsewhere" } });
  expect(committedWrites).toBe(0);
  expect(saveAttempts[0]?.expectedRaw).toBe(initialRaw);

  setDialogMode("preview");
  await waitFor(() => expect(screen.getByText("内容预览")).toBeTruthy());
  setDialogMode("settings");
  await waitFor(() => expect(nativeReadCount()).toBe(2));
  await waitUntilSettingsReady();
  expect((screen.getByRole("checkbox", { name: /紧凑布局/ }) as HTMLInputElement).checked).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "贴顶" }));
  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

  expect(await screen.findByText("已保存")).toBeTruthy();
  expect(saveAttempts).toHaveLength(2);
  expect(saveAttempts[1]?.expectedRaw).toBe(externalRaw);
  expect(Object.keys(saveAttempts[1]!.changes).sort()).toEqual([
    "clipboardRetentionDays",
    "pasteboardAttachmentBudgetBytes",
    "pasteboardCompact",
    "pasteboardDockEdge",
    "pasteboardExcludeSensitiveContent",
  ]);
  expect(saveAttempts[1]?.applyNative).toBe(false);
  expect(saveAttempts[1]?.changes.clipboardRetentionDays).toBe(90);
  expect(committedWrites).toBe(1);
  expect(nativeRecord()).toMatchObject({
    theme: "light",
    futureSetting: { retained: "updated elsewhere" },
    pasteboardDockEdge: "top",
  });
  expect(tauri.invoke.mock.calls.some(([command]) => command === "set_setting")).toBe(false);
});

it.each([
  ["when no settings are stored", null, {}],
  ["when the retention field is absent", JSON.stringify({ theme: "dark", futureSetting: { retained: true } }), {
    theme: "dark",
    futureSetting: { retained: true },
  }],
])("defaults clipboard retention to 180 %s and preserves unrelated settings", async (_label, raw, expected) => {
  currentRaw = raw;
  renderSettingsDialog();
  await waitFor(() => expect(nativeReadCount()).toBe(1));
  await waitUntilSettingsReady();

  expect((screen.getByLabelText(/历史保留/) as HTMLInputElement).value).toBe("180");
  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(await screen.findByText("已保存")).toBeTruthy();
  expect(nativeRecord()).toMatchObject({ ...expected, clipboardRetentionDays: 180 });
  expect(saveAttempts).toHaveLength(1);
  expect(Object.keys(saveAttempts[0]!.changes).sort()).toEqual([
    "clipboardRetentionDays",
    "pasteboardAttachmentBudgetBytes",
    "pasteboardCompact",
    "pasteboardDockEdge",
    "pasteboardExcludeSensitiveContent",
  ]);
});

it("keeps initial load failures unsaveable until a fresh native snapshot is available", async () => {
  readFailure = "native settings read unavailable";
  renderSettingsDialog();

  expect(await screen.findByText(/native settings read unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存设置" }).hasAttribute("disabled")).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(saveAttempts).toHaveLength(0);
  expect(committedWrites).toBe(0);
});

it("reports post-commit layout and notification failures without repeating persistence", async () => {
  notificationDelivered = false;
  repositionFailures = 1;
  renderSettingsDialog();
  await waitFor(() => expect(nativeReadCount()).toBe(1));
  await waitUntilSettingsReady();
  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

  expect(await screen.findByText(/已保存，但货架布局调整失败/)).toBeTruthy();
  expect(screen.getByText(/已保存，更新通知未送达/)).toBeTruthy();
  expect(committedWrites).toBe(1);
  expect(repositionCalls).toBe(1);
  await fireEvent.click(screen.getByRole("button", { name: "重试布局" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(repositionCalls).toBe(2);
  expect(saveAttempts).toHaveLength(1);
  expect(committedWrites).toBe(1);
});

it("ignores a late settings read after the dialog hash switches away and back", async () => {
  deferReads = true;
  renderSettingsDialog();
  await waitFor(() => expect(readReplies).toHaveLength(1));

  setDialogMode("preview");
  await waitFor(() => expect(screen.getByText("内容预览")).toBeTruthy());
  setDialogMode("settings");
  await waitFor(() => expect(readReplies).toHaveLength(2));

  readReplies[1]!(JSON.stringify({ pasteboardCompact: true }));
  await waitFor(() => expect((screen.getByRole("checkbox", { name: /紧凑布局/ }) as HTMLInputElement).checked).toBe(true));
  readReplies[0]!(JSON.stringify({ pasteboardCompact: false }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((screen.getByRole("checkbox", { name: /紧凑布局/ }) as HTMLInputElement).checked).toBe(true);
  expect(saveAttempts).toHaveLength(0);
});

it("keeps one save in flight when the save button is clicked repeatedly", async () => {
  renderSettingsDialog();
  await waitFor(() => expect(nativeReadCount()).toBe(1));
  await waitUntilSettingsReady();
  deferSave = true;

  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(saveAttempts).toHaveLength(1));
  const saveButton = screen.getByRole("button", { name: "保存中…" });
  expect(saveButton.hasAttribute("disabled")).toBe(true);
  await fireEvent.click(saveButton);
  expect(saveAttempts).toHaveLength(1);

  deferredSave!();
  expect(await screen.findByText("已保存")).toBeTruthy();
  expect(committedWrites).toBe(1);
  expect(repositionCalls).toBe(1);
});

it("does not treat dialog disposal as cancellation of an already dispatched native save", async () => {
  const view = renderSettingsDialog();
  await waitFor(() => expect(nativeReadCount()).toBe(1));
  await waitUntilSettingsReady();
  deferSave = true;

  await fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(saveAttempts).toHaveLength(1));
  view.unmount();
  deferredSave!();

  await waitFor(() => expect(repositionCalls).toBe(1));
  expect(committedWrites).toBe(1);
  expect(saveAttempts).toHaveLength(1);
});
