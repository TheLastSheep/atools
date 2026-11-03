(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__) return;

  const FIELDS = Object.freeze({
    showRecentInSearch: { kind: "checkbox", label: "搜索框显示最近使用" },
    recentRows: { kind: "dropdown", label: "最近使用显示行数" },
    pinnedRows: { kind: "dropdown", label: "固定栏显示行数" },
    searchMode: { kind: "dropdown", label: "搜索框模式" },
    showMatchRecommendation: { kind: "checkbox", label: "匹配推荐" },
    tabKeyFunction: { kind: "dropdown", label: "Tab 功能" },
    tabTargetCommand: { kind: "text", label: "Tab 键目标指令" },
    spaceOpenCommand: { kind: "checkbox", label: "空格打开指令" },
  });
  const CHILD_SESSION = () => window.__ATOOLS_SETTINGS_VIEW_CONFIG__?.sessionId ?? "";
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function sameValue(left, right) {
    return left === right;
  }

  function labelNode(field) {
    const definition = FIELDS[field];
    if (!definition) return null;
    return [...document.querySelectorAll(".setting-label")].find((node) =>
      node.querySelector("span")?.textContent?.trim() === definition.label,
    ) ?? null;
  }

  function controlFor(field) {
    const definition = FIELDS[field];
    const label = labelNode(field);
    if (!definition || !label) return null;
    const selector = definition.kind === "checkbox" ? 'input[type="checkbox"]'
      : definition.kind === "dropdown" ? ".dropdown-trigger"
        : 'input[type="text"]';
    const row = label.closest?.(".setting-item");
    if (!row) return null;
    const control = row.querySelector(selector);
    return control && !control.disabled && control.isConnected !== false ? control : null;
  }

  function optionLabel(field, value) {
    if (field === "searchMode") return value === "aggregate" ? "聚合模式" : "列表模式";
    if (field === "tabKeyFunction") return value === "target-command" ? "目标指令" : "切换选中";
    if (field === "recentRows" || field === "pinnedRows") return `${value}行`;
    return String(value);
  }

  function valueFromControl(field, control) {
    if (!control) return null;
    const kind = FIELDS[field]?.kind;
    if (kind === "checkbox") return typeof control.checked === "boolean" ? control.checked : null;
    if (kind === "text") return typeof control.value === "string" ? control.value : null;
    if (kind !== "dropdown") return null;
    const text = control.querySelector(".dropdown-value")?.textContent?.trim();
    if (typeof text !== "string" || text.length === 0) return null;
    if (field === "searchMode") {
      if (text === "聚合模式") return "aggregate";
      if (text === "列表模式") return "list";
      return null;
    }
    if (field === "tabKeyFunction") {
      if (text === "目标指令") return "target-command";
      if (text === "切换选中") return "navigate";
      return null;
    }
    const rowCount = text.match(/^(\d+)行$/);
    const numeric = rowCount ? Number(rowCount[1]) : Number(text);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 20 ? numeric : null;
  }

  function optionNode(control, label) {
    const dropdown = control?.closest?.(".dropdown");
    if (!dropdown) return null;
    return [...dropdown.querySelectorAll(".dropdown-menu .dropdown-item")].find((node) =>
      node.querySelector(".dropdown-item-label")?.textContent?.trim() === label,
    ) ?? null;
  }

  async function waitForControl(field, deadline) {
    let control = null;
    while (Date.now() < deadline) {
      control = controlFor(field);
      if (control) return control;
      await delay(30);
    }
    return control;
  }

  async function waitForControlValue(field, control, target, deadline) {
    let value = valueFromControl(field, control);
    while (Date.now() < deadline) {
      if (sameValue(value, target)) return value;
      await delay(30);
      value = valueFromControl(field, control);
    }
    return value;
  }

  async function waitForOption(control, label, deadline) {
    let option = null;
    while (Date.now() < deadline) {
      option = optionNode(control, label);
      if (option) return option;
      await delay(20);
    }
    return option;
  }

  function observeEvents(element, names) {
    const counts = Object.create(null);
    const listeners = [];
    for (const name of names) {
      counts[name] = 0;
      const listener = () => { counts[name] += 1; };
      element.addEventListener(name, listener, true);
      listeners.push([name, listener]);
    }
    return {
      counts,
      dispose() {
        for (const [name, listener] of listeners) element.removeEventListener(name, listener, true);
      },
    };
  }

  async function readNative() {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    const sessionId = CHILD_SESSION();
    if (typeof invoke !== "function" || typeof sessionId !== "string" || sessionId.length === 0) {
      return null;
    }
    try {
      const reply = await invoke("call_renderer_settings", {
        sessionId,
        operation: "readGeneral",
        payload: {},
      });
      if (!reply || typeof reply.revision !== "string" || !reply.value ||
          typeof reply.value !== "object" || Array.isArray(reply.value)) return null;
      return reply;
    } catch (_) {
      return null;
    }
  }

  async function waitForNativeValue(field, target, beforeRevision, deadline) {
    let latest = null;
    while (Date.now() < deadline) {
      latest = await readNative();
      if (latest && sameValue(latest.value[field], target) && latest.revision !== beforeRevision) {
        return latest;
      }
      await delay(30);
    }
    return latest;
  }

  function performCheckbox(control, target) {
    const events = observeEvents(control, ["click", "input", "change"]);
    try {
      if (control.checked !== target) control.click();
      const actionObserved = events.counts.click > 0 && events.counts.input > 0 && events.counts.change > 0;
      const value = control.checked;
      return {
        actionObserved,
        value,
        stage: !actionObserved ? "checkbox-event-missing"
          : !sameValue(value, target) ? "control-value-mismatch" : "complete",
      };
    } finally {
      events.dispose();
    }
  }

  async function performDropdown(field, control, target, deadline) {
    const events = observeEvents(control, ["click"]);
    try {
      control.click();
      if (events.counts.click === 0) {
        return { actionObserved: false, value: valueFromControl(field, control), stage: "dropdown-trigger-missing" };
      }
      const option = await waitForOption(control, optionLabel(field, target), deadline);
      if (!option) {
        return { actionObserved: false, value: valueFromControl(field, control), stage: "dropdown-option-missing" };
      }
      const optionEvents = observeEvents(option, ["click"]);
      try {
        option.click();
        const actionObserved = events.counts.click > 0 && optionEvents.counts.click > 0;
        if (!actionObserved) {
          return { actionObserved, value: valueFromControl(field, control), stage: "dropdown-option-click-missing" };
        }
        const value = await waitForControlValue(field, control, target, deadline);
        return {
          actionObserved,
          value,
          stage: sameValue(value, target) ? "complete" : "control-value-mismatch",
        };
      } finally {
        optionEvents.dispose();
      }
    } finally {
      events.dispose();
    }
  }

  function performTextInput(control, target) {
    const events = observeEvents(control, ["input", "blur"]);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (!descriptor || typeof descriptor.set !== "function") {
        return { actionObserved: false, value: valueFromControl("tabTargetCommand", control), stage: "text-input-unavailable" };
      }
      control.focus();
      descriptor.set.call(control, target);
      control.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: target,
      }));
      control.blur();
      const actionObserved = events.counts.input > 0 && events.counts.blur > 0;
      const value = valueFromControl("tabTargetCommand", control);
      return {
        actionObserved,
        value,
        stage: !actionObserved ? "text-input-event-missing"
          : !sameValue(value, target) ? "control-value-mismatch" : "complete",
      };
    } finally {
      events.dispose();
    }
  }

  async function edit(token, generation, field, target) {
    const nativeBefore = await readNative();
    const deadline = Date.now() + 9000;
    const control = await waitForControl(field, deadline);
    const before = valueFromControl(field, control);
    let result = { actionObserved: false, value: before, stage: "control-missing" };
    if (control && FIELDS[field]) {
      if (FIELDS[field].kind === "checkbox") result = performCheckbox(control, target);
      else if (FIELDS[field].kind === "dropdown") result = await performDropdown(field, control, target, deadline);
      else result = performTextInput(control, target);
    }
    const after = result.value;
    let nativeAfter = null;
    if (result.stage === "complete" && nativeBefore) {
      nativeAfter = await waitForNativeValue(field, target, nativeBefore.revision, deadline);
    } else {
      nativeAfter = await readNative();
    }
    const nativeReadbackMatches = sameValue(nativeAfter?.value?.[field], target);
    const revisionAdvanced = Boolean(
      nativeBefore && nativeAfter && nativeBefore.revision !== nativeAfter.revision,
    );
    let stage = result.stage;
    if (stage === "complete" && !nativeAfter) stage = "native-readback-missing";
    else if (stage === "complete" && !nativeReadbackMatches) stage = "native-value-mismatch";
    else if (stage === "complete" && !revisionAdvanced) stage = "native-revision-not-advanced";
    await send(token, "childPreferenceEdit", generation, {
      field,
      controlFound: Boolean(control),
      actionObserved: result.actionObserved,
      valueChanged: !sameValue(before, after),
      matchesTarget: sameValue(after, target),
      nativeReadbackMatches,
      revisionAdvanced,
      uiValue: after,
      stage,
    });
  }

  async function reject(token, operation, generation, change) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    const before = await readNative();
    let errorCode = "unobserved";
    if (before && typeof invoke === "function") {
      try {
        await invoke("call_renderer_settings", {
          sessionId: CHILD_SESSION(),
          operation: "patchGeneral",
          payload: { revision: before.revision, changes: change(before.value) },
        });
      } catch (error) {
        errorCode = typeof error?.code === "string" ? error.code.slice(0, 64) : "unobserved";
      }
    }
    const after = await readNative();
    await send(token, operation, generation, {
      errorCode,
      revisionBefore: before?.revision ?? "unobserved",
      revisionAfter: after?.revision ?? "unobserved",
      projectionUnchanged: Boolean(before && after && sameJsonValue(before.value, after.value)),
      readSucceeded: Boolean(before && after),
    });
  }

  async function rejectReadonly(token, generation) {
    await reject(token, "childPreferenceRejectReadonly", generation, (general) => ({
      windowDefaultHeight: (Number(general.windowDefaultHeight) || 2001) + 1,
    }));
  }

  async function rejectInvalid(token, generation) {
    await reject(token, "childPreferenceRejectInvalid", generation, () => ({ recentRows: "3" }));
  }

  async function inspectReopened(token, generation) {
    const controlFound = Object.create(null);
    const controlValues = Object.create(null);
    for (const field of Object.keys(FIELDS)) {
      const control = controlFor(field);
      const value = valueFromControl(field, control);
      controlFound[field] = Boolean(control);
      controlValues[field] = value;
    }
    const native = await readNative();
    const nativeValues = Object.create(null);
    for (const field of Object.keys(FIELDS)) {
      nativeValues[field] = native?.value?.[field] ?? null;
    }
    await send(token, "childPreferencesReopen", generation, {
      nativeReadSucceeded: Boolean(native),
      controlFound,
      controlValues,
      nativeValues,
    });
  }

  function sameJsonValue(left, right, depth = 0) {
    if (left === right) return true;
    if (depth > 8 || left === null || right === null ||
        typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
        left.every((value, index) => sameJsonValue(value, right[index], depth + 1));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
      Object.hasOwn(right, key) && sameJsonValue(left[key], right[key], depth + 1),
    );
  }

  async function send(token, operation, generation, evidence) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_journey_probe", { token, operation, generation, evidence });
      return true;
    } catch (_) {
      return false;
    }
  }

  Object.defineProperty(window, "__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__", {
    value: Object.freeze({ edit, rejectReadonly, rejectInvalid, inspectReopened }),
    configurable: false,
    writable: false,
  });
})();
