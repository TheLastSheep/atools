(function installRegistrationProbe(role, documentId) {
  "use strict";
  if (window.__ATOOLS_SETTINGS_REGISTRATION__) return;
  let pending = null;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(fn, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { if (fn()) return true; } catch (_) {}
      await delay(25);
    }
    return false;
  }
  const adapter = () => window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() ?? null;
  const counters = () => {
    const state = adapter();
    const calls = state?.nativeCalls;
    const local = state?.localShortcutEvents;
    if (!calls || !local) return null;
    return { openCalls: calls.open_renderer_settings ?? 0, launchCalls: calls.launch_renderer_app ?? 0,
      deliveredEvents: local.deliveredEvents, latestRevision: local.latestRevision,
      outstandingNativeCalls: state.outstandingNativeCalls };
  };
  const rows = () => Array.from(document.querySelectorAll(".shortcut-item"), (row) => ({
    path: row.getAttribute("title"), name: row.querySelector(".shortcut-name")?.textContent?.trim() ?? null,
  }));
  const rowFor = (path) => Array.from(document.querySelectorAll(".shortcut-item"))
    .find((row) => row.getAttribute("title") === path);
  const input = () => document.querySelector("input.search-input");
  function setInput(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(element instanceof HTMLInputElement) || !setter) return false;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value === value;
  }
  function matchingCommands(query, path) {
    const root = document.querySelector("#app");
    const provides = root?.__vue_app__?._context?.provides;
    if (!provides) return null;
    const pinia = Reflect.ownKeys(provides).map((key) => provides[key])
      .filter((value) => value?._s instanceof Map && value._s.has("commandData"));
    if (pinia.length !== 1) return null;
    const found = pinia[0]._s.get("commandData")?.search?.(query);
    if (!Array.isArray(found?.bestMatches) || !Array.isArray(found?.regexMatches)) return null;
    return [...found.bestMatches, ...found.regexMatches].filter((item) =>
      item?.path === path && item.type === "direct" && item.subType === "local-shortcut").length;
  }
  async function checkCaller(sessionId) {
    try {
      await window.__TAURI_INTERNALS__.invoke("call_renderer_settings", {
        sessionId, operation: "readLocalShortcuts", payload: {},
      });
      return false;
    } catch (error) { return error?.code === "SETTINGS_CALLER_REJECTED"; }
  }
  async function checkAcl() {
    const internals = window.__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== "function" || typeof internals?.transformCallback !== "function" ||
        typeof internals?.unregisterCallback !== "function") return null;
    const answer = { cleanup: true };
    for (const [key, event] of [["dragEnter", "tauri://drag-enter"], ["dragOver", "tauri://drag-over"],
      ["dragDrop", "tauri://drag-drop"], ["dragLeave", "tauri://drag-leave"]]) {
      const handler = internals.transformCallback(() => {});
      let id = null;
      try {
        id = await internals.invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler });
        answer[key] = "allowed";
      } catch (error) {
        answer[key] = /not allowed|permission|denied/i.test(String(error?.message ?? error)) ? "denied" : "error";
      } finally {
        if (id !== null) {
          try {
            window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, id);
            await internals.invoke("plugin:event|unlisten", { event, eventId: id });
          } catch (_) { answer.cleanup = false; }
        }
        internals.unregisterCallback(handler);
      }
    }
    return answer;
  }
  async function operate(op, arg) {
    if (op === "inspect") return { role, documentId, href: location.href,
      documentVisibility: document.visibilityState, documentHasFocus: document.hasFocus(),
      config: window.__ATOOLS_SETTINGS_VIEW_CONFIG__ ?? null, counters: role === "main" ? counters() : null,
      rows: role === "child" ? rows() : null };
    if (op === "open" && role === "main") {
      const before = counters();
      const element = document.querySelectorAll(".avatar-wrapper");
      if (element.length !== 1 || !before) return null;
      element[0].click();
      const settled = await until(() => counters()?.openCalls === before.openCalls + 1);
      return { before, after: counters(), clicked: settled };
    }
    if (op === "navigate" && role === "child") {
      const menu = Array.from(document.querySelectorAll(".menu-item"))
        .filter((item) => item.querySelector(".menu-label")?.textContent?.trim() === "本地启动");
      if (menu.length !== 1) return null;
      menu[0].click();
      const ready = await until(() => location.hash.startsWith("#/localLaunch") &&
        document.querySelectorAll(".content-panel .scrollable-content").length === 1);
      return { ready, href: location.href, rows: rows() };
    }
    if (op === "list" && role === "child") {
      const feedback = () => Boolean(document.querySelector(".toast-success .toast-content")?.textContent?.includes("添加成功"));
      const ready = await until(() => rows().length === arg.count &&
        (arg.count !== 0 || Boolean(document.querySelector(".empty-state .empty-text"))) &&
        (!arg.feedback || feedback()));
      return { ready, rows: rows(), feedback: feedback() };
    }
    if (op === "alias" && role === "child") {
      const row = rowFor(arg.path);
      const button = row?.querySelector(".alias-btn");
      if (!button) return null;
      button.click();
      if (!await until(() => row.querySelector(".alias-input") instanceof HTMLInputElement, 1000)) return null;
      const edit = row.querySelector(".alias-input");
      if (!setInput(edit, arg.value)) return null;
      edit.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      const expected = arg.value || arg.name;
      const saved = await until(() => !row.querySelector(".alias-input") && row.querySelector(".shortcut-name")?.textContent?.includes(expected));
      return { saved, rows: rows() };
    }
    if (op === "delete" && role === "child") {
      const row = rowFor(arg.path);
      const button = row?.querySelector(".delete-btn");
      if (!button) return null;
      button.click();
      const ready = await until(() => document.querySelector(".dialog-message")?.textContent?.includes(arg.name));
      const confirm = document.querySelector(".btn-warning");
      if (!ready || !(confirm instanceof HTMLElement)) return null;
      confirm.click();
      const deleted = await until(() => !rowFor(arg.path));
      return { deleted, rows: rows() };
    }
    if (op === "acl" && role === "child") return checkAcl();
    if (op === "wrongCaller") return { rejected: await checkCaller(arg.sessionId) };
    if (op === "search" && role === "main") {
      const before = counters();
      if (!before || !setInput(input(), arg.query)) return null;
      const matched = await until(() => matchingCommands(arg.query, arg.path) === 1 &&
        Array.from(document.querySelectorAll(".list-mode-results .list-item"))
          .some((item) => item.querySelector(".item-title")?.textContent?.trim() === arg.query &&
            item.querySelector(".item-subtitle")?.textContent?.trim() === arg.path));
      const after = counters();
      setInput(input(), "");
      await until(() => input()?.value === "" && counters()?.outstandingNativeCalls === 0);
      return { matched, before, after, subtypeCount: matchingCommands(arg.query, arg.path) };
    }
    if (op === "close" && role === "child" && typeof window.ztools?.outPlugin === "function") {
      setTimeout(() => { void window.ztools.outPlugin(); }, 300);
      return { requested: true };
    }
    return null;
  }
  Object.defineProperty(window, "__ATOOLS_SETTINGS_REGISTRATION__", { enumerable: false, configurable: false,
    value: Object.freeze({
      start(nonce, op, arg) {
        if (pending || !/^[a-f0-9]{32}$/.test(nonce)) return false;
        pending = { nonce, done: false, value: null };
        Promise.resolve().then(() => operate(op, arg)).then((value) => {
          if (pending?.nonce === nonce) { pending.value = value; pending.done = true; }
        }, () => { if (pending?.nonce === nonce) { pending.value = null; pending.done = true; } });
        return true;
      },
      read(nonce) {
        if (!pending || pending.nonce !== nonce) return null;
        const reply = { nonce, role, documentId, done: pending.done, value: pending.value };
        if (pending.done) pending = null;
        return reply;
      },
      cancel(nonce) { if (pending?.nonce === nonce) pending = null; }
    }) });
})(__ATOOLS_SETTINGS_REGISTRATION_ROLE__, __ATOOLS_SETTINGS_REGISTRATION_DOCUMENT__);
