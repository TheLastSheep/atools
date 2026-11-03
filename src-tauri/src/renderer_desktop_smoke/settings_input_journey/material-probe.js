(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_MATERIAL__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const labels = new Map([
    ["system", "跟随系统"],
    ["light", "明亮"],
    ["dark", "暗黑"],
  ]);
  const themes = new Map(Array.from(labels, ([theme, label]) => [label, theme]));
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function waitFor(predicate, deadline) {
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    return Date.now() <= deadline && Boolean(predicate());
  }

  async function send(operation, evidence, probeId) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_input_probe", { token, operation, probeId, evidence });
      return true;
    } catch (_) {
      return false;
    }
  }

  function routePath() {
    return window.location.hash.slice(1).split("?")[0];
  }

  function themeControl() {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter((row) =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === "主题设置");
    return rows.length === 1 ? rows[0].querySelector(".setting-control .dropdown") : null;
  }

  function selectedTheme(dropdown) {
    return themes.get(dropdown?.querySelector(".dropdown-value")?.textContent?.trim()) ?? null;
  }

  function expectedTextColor(theme) {
    return theme === "light" ? [51, 51, 51] : theme === "dark" ? [243, 244, 246] : null;
  }

  function colorChannels(value) {
    if (typeof value !== "string") return null;
    const color = value.trim().toLowerCase();
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (hex) {
      const digits = hex[1].length === 3
        ? Array.from(hex[1], (digit) => digit + digit).join("")
        : hex[1];
      return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
    }
    const rgb = color.match(/^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:\s*[,/]\s*(1(?:\.0*)?|100%))?\s*\)$/);
    if (!rgb || (rgb[4] !== undefined && rgb[4] !== "100%" && Number(rgb[4]) !== 1)) return null;
    const channels = rgb.slice(1, 4).map(Number);
    return channels.every((channel) => channel <= 255) ? channels : null;
  }

  function colorMatches(value, theme) {
    const expected = expectedTextColor(theme);
    const channels = colorChannels(value);
    return expected !== null && channels !== null
      && channels.every((channel, index) => channel === expected[index]);
  }

  function colorValuesEqual(left, right) {
    const leftChannels = colorChannels(left);
    const rightChannels = colorChannels(right);
    return leftChannels !== null && rightChannels !== null
      && leftChannels.every((channel, index) => channel === rightChannels[index]);
  }

  function sidebarPaintFacts(theme) {
    const generalItems = Array.from(document.querySelectorAll(".menu-item")).filter((item) =>
      item.querySelector(".menu-label")?.textContent?.trim() === "通用设置");
    const shortcutItems = Array.from(document.querySelectorAll(".menu-item")).filter((item) =>
      item.querySelector(".menu-label")?.textContent?.trim() === "快捷键");
    const generalItem = generalItems.length === 1 ? generalItems[0] : null;
    const shortcutItem = shortcutItems.length === 1 ? shortcutItems[0] : null;
    const generalLabel = generalItem?.querySelector(".menu-label") ?? null;
    const shortcutLabel = shortcutItem?.querySelector(".menu-label") ?? null;
    const rootStyle = getComputedStyle(document.documentElement);
    const generalColor = generalLabel === null ? null : getComputedStyle(generalLabel).color;
    const shortcutColor = shortcutLabel === null ? null : getComputedStyle(shortcutLabel).color;
    const primaryColor = rootStyle.getPropertyValue("--primary-color");
    const textColor = rootStyle.getPropertyValue("--text-color");
    const generalColorComparable = colorChannels(generalColor) !== null
      && colorChannels(primaryColor) !== null;
    const shortcutColorComparable = colorChannels(shortcutColor) !== null
      && colorChannels(textColor) !== null;
    return {
      generalUnique: generalItem !== null,
      generalActive: generalItem?.classList.contains("active") === true,
      generalColorComparable,
      generalColorUsesPrimary: generalColorComparable
        && colorValuesEqual(generalColor, primaryColor),
      shortcutUnique: shortcutItem !== null,
      shortcutInactive: shortcutItem !== null && !shortcutItem.classList.contains("active"),
      shortcutColorComparable,
      shortcutColorUsesText: shortcutColorComparable
        && colorValuesEqual(shortcutColor, textColor),
      shortcutColorMatchesTheme: shortcutLabel !== null
        && colorMatches(shortcutColor, theme),
    };
  }

  function paintMenuFacts(themeDropdown) {
    const menus = Array.from(document.querySelectorAll(".dropdown-menu"));
    const themeMenus = menus.filter((menu) => themeDropdown?.contains(menu) === true);
    const bodyMenus = menus.filter((menu) =>
      menu.parentElement === document.body && !themeDropdown?.contains(menu));
    const hasTransitionClass = (menu, direction) => [
      `dropdown-menu-${direction}-from`,
      `dropdown-menu-${direction}-active`,
      `dropdown-menu-${direction}-to`,
    ].some((className) => menu.classList.contains(className));
    const visible = menus.filter((menu) => {
      const style = getComputedStyle(menu);
      const rect = menu.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && menu.getClientRects().length > 0
        && rect.width > 0
        && rect.height > 0;
    });
    return {
      total: menus.length,
      body: bodyMenus.length,
      theme: themeMenus.length,
      leave: menus.filter((menu) => hasTransitionClass(menu, "leave")).length,
      enter: menus.filter((menu) => hasTransitionClass(menu, "enter")).length,
      ownersOpen: document.querySelectorAll(".tag-dropdown.open").length,
      visible: visible.length,
    };
  }

  function paintDiagnosticFacts(theme) {
    const dropdown = themeControl();
    const sidebar = sidebarPaintFacts(theme);
    return {
      sidebar: {
        generalUnique: sidebar.generalUnique,
        generalActive: sidebar.generalActive,
        generalColorComparable: sidebar.generalColorComparable,
        generalColorUsesPrimary: sidebar.generalColorUsesPrimary,
        shortcutUnique: sidebar.shortcutUnique,
        shortcutInactive: sidebar.shortcutInactive,
        shortcutColorComparable: sidebar.shortcutColorComparable,
        shortcutColorUsesText: sidebar.shortcutColorUsesText,
      },
      menus: paintMenuFacts(dropdown),
    };
  }

  function snapshotFacts(theme) {
    const routeGeneral = routePath() === "/generalSetting";
    const dropdown = themeControl();
    const sidebar = sidebarPaintFacts(theme);
    const labelItems = Array.from(document.querySelectorAll(".setting-item")).filter((item) =>
      item.querySelector(".setting-label > span")?.textContent?.trim() === "主题设置");
    const rootStyle = getComputedStyle(document.documentElement);
    const mediaMatches = selectedTheme(dropdown) === theme
      && (theme === "dark") === mediaDark();
    const menusAbsent = dropdown !== null
      && !dropdown.classList.contains("open")
      && document.querySelectorAll(".dropdown-menu").length === 0
      && document.querySelectorAll(".tag-dropdown.open").length === 0;
    const settingLabel = labelItems.length === 1
      ? labelItems[0].querySelector(".setting-label > span")
      : null;
    return {
      routeGeneral,
      mediaMatches,
      menusAbsent,
      rootTextMatches: colorMatches(rootStyle.getPropertyValue("--text-color"), theme),
      sidebarTextMatches: sidebar.generalUnique
        && sidebar.generalActive
        && sidebar.generalColorUsesPrimary
        && sidebar.shortcutUnique
        && sidebar.shortcutInactive
        && sidebar.shortcutColorMatchesTheme,
      labelTextMatches: settingLabel !== null
        && colorMatches(getComputedStyle(settingLabel).color, theme),
      selectedThemeMatches: selectedTheme(dropdown) === theme,
    };
  }

  function observeTwoFramesWithinOneSecond() {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (observed) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(observed);
      };
      const timeout = setTimeout(() => finish(false), 1000);
      requestAnimationFrame(() => {
        if (finished) return;
        requestAnimationFrame(() => finish(true));
      });
    });
  }

  function observePaintDiagnosticFrames(startedAt) {
    return new Promise((resolve) => {
      let finished = false;
      let rafCallbacks = 0;
      const finish = (timedOut) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve({ rafCallbacks, timedOut });
      };
      const remaining = Math.max(0, 1000 - (performance.now() - startedAt));
      const timeout = setTimeout(() => finish(true), remaining);
      if (typeof requestAnimationFrame !== "function") return;
      requestAnimationFrame(() => {
        if (finished) return;
        if (performance.now() - startedAt >= 1000) return finish(true);
        rafCallbacks += 1;
        requestAnimationFrame(() => {
          if (finished) return;
          if (performance.now() - startedAt >= 1000) return finish(true);
          rafCallbacks += 1;
          finish(false);
        });
      });
    });
  }

  async function childPaintDiagnostic(probeId, theme) {
    const validTheme = theme === "light" || theme === "dark";
    const startedAt = performance.now();
    const before = validTheme ? paintDiagnosticFacts(theme) : null;
    const frameResult = validTheme
      ? await observePaintDiagnosticFrames(startedAt)
      : { rafCallbacks: 0, timedOut: true };
    const after = validTheme ? paintDiagnosticFacts(theme) : null;
    const evidence = {
      documentHidden: document.hidden === true,
      before,
      after,
      rafCallbacks: frameResult.rafCallbacks,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      timedOut: frameResult.timedOut,
    };
    await send("childPaintDiagnostic", evidence, probeId);
  }

  async function childSnapshotReady(probeId, theme) {
    const validTheme = theme === "light" || theme === "dark";
    const before = validTheme ? snapshotFacts(theme) : null;
    const framesObserved = validTheme && await observeTwoFramesWithinOneSecond();
    const after = validTheme ? snapshotFacts(theme) : null;
    const stableKeys = [
      "routeGeneral",
      "mediaMatches",
      "menusAbsent",
      "rootTextMatches",
      "sidebarTextMatches",
      "labelTextMatches",
    ];
    const afterFacts = after ?? {
      routeGeneral: false,
      mediaMatches: false,
      menusAbsent: false,
      rootTextMatches: false,
      sidebarTextMatches: false,
      labelTextMatches: false,
    };
    const facts = Object.fromEntries(stableKeys.map((key) => [
      key,
      before !== null && before[key] === true && afterFacts[key] === true,
    ]));
    const stable = framesObserved && stableKeys.every((key) => facts[key]);
    await send("childSnapshotReady", {
      routeGeneral: facts.routeGeneral,
      mediaMatches: facts.mediaMatches,
      menusAbsent: facts.menusAbsent,
      rootTextMatches: facts.rootTextMatches,
      sidebarTextMatches: facts.sidebarTextMatches,
      labelTextMatches: facts.labelTextMatches,
      framesObserved: framesObserved === true,
      settled: stable,
    }, probeId);
  }

  function selectedLabels(dropdown) {
    return Array.from(dropdown?.querySelectorAll(".dropdown-menu .dropdown-item-label") ?? [])
      .map((item) => item.textContent?.trim() ?? "");
  }

  function documentEvidence() {
    return {
      documentHidden: document.hidden === true,
      documentHasFocus: document.hasFocus() === true,
    };
  }

  function mediaDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches === true;
  }

  async function readStoredTheme() {
    const internal = window.ztools?.internal;
    if (typeof internal?.dbGet !== "function") return null;
    try {
      const value = await internal.dbGet("settings-general");
      return value !== null && typeof value === "object" && !Array.isArray(value)
        && labels.has(value.theme) ? value.theme : null;
    } catch (_) {
      return null;
    }
  }

  async function inspectCurrentTheme(probeId) {
    const route = routePath();
    const menu = Array.from(document.querySelectorAll(".menu-item")).find((item) =>
      item.querySelector(".menu-label")?.textContent?.trim() === "通用设置");
    const dropdown = themeControl();
    const committedTheme = await readStoredTheme();
    await send("childThemeInspect", {
      routeAllCommands: route === "/allCommands",
      routeGeneral: route === "/generalSetting",
      sidebarFound: Boolean(menu),
      themeControlFound: dropdown !== null,
      selectedTheme: selectedTheme(dropdown),
      committedTheme,
      mediaDark: mediaDark(),
      ...documentEvidence(),
    }, probeId);
  }

  async function navigateGeneral(probeId) {
    const deadline = Date.now() + 6000;
    let sidebarFound = false;
    let navigationDispatched = false;
    const menu = Array.from(document.querySelectorAll(".menu-item")).find((item) =>
      item.querySelector(".menu-label")?.textContent?.trim() === "通用设置");
    sidebarFound = Boolean(menu);
    if (routePath() !== "/generalSetting" && menu) {
      menu.click();
      navigationDispatched = true;
      await waitFor(() => routePath() === "/generalSetting", deadline);
    }
    await waitFor(() => routePath() === "/generalSetting" && themeControl() !== null, deadline);
    const dropdown = themeControl();
    const committedTheme = await readStoredTheme();
    await send("childThemeNavigate", {
      routeAllCommands: routePath() === "/allCommands",
      routeGeneral: routePath() === "/generalSetting",
      sidebarFound,
      navigationDispatched,
      themeControlFound: dropdown !== null,
      selectedTheme: selectedTheme(dropdown),
      committedTheme,
      mediaDark: mediaDark(),
      ...documentEvidence(),
    }, probeId);
  }

  async function selectGeneralTheme(probeId, theme) {
    const deadline = Date.now() + 1200;
    const dropdown = themeControl();
    const row = dropdown?.closest(".setting-item");
    const trigger = dropdown?.querySelector(".dropdown-trigger");
    let themeMenuOpened = false;
    let optionSetValid = false;
    let selectionDispatched = false;
    let selected = false;

    if (labels.has(theme) && routePath() === "/generalSetting" && dropdown && row && trigger) {
      if (!dropdown.classList.contains("open")) trigger.click();
      themeMenuOpened = await waitFor(() => dropdown.classList.contains("open"), deadline);
      const options = selectedLabels(dropdown);
      optionSetValid = options.length === labels.size
        && new Set(options).size === labels.size
        && Array.from(labels.values()).every((label) => options.includes(label));
      const matches = Array.from(dropdown.querySelectorAll(".dropdown-menu .dropdown-item"))
        .filter((item) => item.querySelector(".dropdown-item-label")?.textContent?.trim() === labels.get(theme));
      if (themeMenuOpened && optionSetValid && matches.length === 1) {
        matches[0].click();
        selectionDispatched = true;
        selected = await waitFor(() => selectedTheme(dropdown) === theme
          && !dropdown.classList.contains("open"), deadline);
      }
    }

    const committedTheme = selectionDispatched
      ? await Promise.race([readStoredTheme(), delay(Math.max(0, deadline - Date.now())).then(() => null)])
      : null;
    await send("childThemeSelect", {
      routeAllCommands: routePath() === "/allCommands",
      routeGeneral: routePath() === "/generalSetting",
      themeControlFound: dropdown !== null,
      themeMenuOpened,
      optionSetValid,
      selectionDispatched,
      selected,
      selectedTheme: selectedTheme(dropdown),
      committedTheme,
      mediaDark: mediaDark(),
      ...documentEvidence(),
    }, probeId);
  }

  async function inspectMainTheme(probeId) {
    await send("mainThemeInspect", {
      mediaDark: mediaDark(),
      ...documentEvidence(),
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_MATERIAL__ = Object.freeze({
    inspectCurrentTheme,
    navigateGeneral,
    selectGeneralTheme,
    inspectMainTheme,
    childSnapshotReady,
    childPaintDiagnostic,
  });
})();
