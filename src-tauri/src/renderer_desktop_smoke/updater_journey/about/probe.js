(() => {
  if (window.__ATOOLS_UPDATER_ABOUT_NATIVE_PROBE__) return;
  const token = "__UPDATER_ABOUT_NATIVE_TOKEN__";
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const calls = { version: 0, manual: 0, auto: 0 };
  const results = { version: null, manual: null, auto: null };
  const failures = { version: null, manual: null, auto: null };
  let wrapped = false;
  const bounded = (value, max) => {
    let text = String(value ?? '');
    while (new TextEncoder().encode(text).length > max) text = text.slice(0, -1);
    return text;
  };
  const wait = async (test) => {
    const deadline = performance.now() + 12000;
    while (!test()) {
      if (performance.now() >= deadline) throw new Error('finite about probe timed out');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  async function withinDeadline(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('finite about IPC timed out'), { code: 'PROBE_TIMEOUT' })), 12000); })]);
    } finally { clearTimeout(timer); }
  }
  async function rejectedByHost(promise) {
    try { await withinDeadline(promise); return false; }
    catch (error) { if (error?.code === 'PROBE_TIMEOUT') throw error; return true; }
  }
  function wrapFacade() {
    if (wrapped) return;
    const api = window.ztools?.internal;
    if (!api) throw new Error('Settings facade unavailable');
    for (const [name, key] of [['getAppVersion', 'version'], ['updaterCheckUpdate', 'manual'], ['updaterSetAutoCheck', 'auto']]) {
      const original = api[name];
      if (typeof original !== 'function') throw new Error('Settings facade method unavailable');
      api[name] = function (...args) {
        calls[key] += 1;
        let value;
        try { value = Reflect.apply(original, this, args); }
        catch (error) { failures[key] = error; throw error; }
        Promise.resolve(value).then(result => { results[key] = result; }, error => { failures[key] = error; });
        return value;
      };
      if (api[name] === original) throw new Error('Settings facade wrapper failed');
    }
    wrapped = true;
  }
  const counts = () => ({ version: calls.version, manual: calls.manual, auto: calls.auto });
  const emptyReceipt = () => ({ version: null, manual: null, auto: null, apiCalls: null, negative: null });
  function dom(ready, disposed = null) {
    const version = document.querySelector('.about-version');
    const checkbox = document.querySelector('#auto-check-update');
    const button = document.querySelector('.check-update-btn');
    const title = document.querySelector('.title');
    const text = document.querySelector('.update-window');
    const revision = window.__ATOOLS_SETTINGS_VIEW_CONFIG__?.bundleRevision;
    return {
      ready, title: bounded(title?.textContent, 256), text: bounded(text?.textContent, 2048),
      appVersion: version ? bounded(version.textContent, 128) : null,
      autoChecked: checkbox ? checkbox.checked : null,
      checkDisabled: button ? button.disabled : null,
      bridgePresent: typeof window.ztools?.internal?.getAppVersion === 'function' ||
        typeof window.ztools?.updater?.startUpdate === 'function' || typeof window.ztools?.openSettings === 'function',
      disposed, bundleRevision: typeof revision === 'string' ? revision : null,
    };
  }
  function send(stage, pageDom, receipt) {
    const value = { dom: pageDom, receipt };
    if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) throw new Error('about receipt exceeds limit');
    return withinDeadline(invoke('updater_about_observe', { token, stage, receipt: value }));
  }
  function failIf(key) { if (failures[key]) throw new Error(`about ${key} request failed`); }
  function navigateAbout() {
    const matches = Array.from(document.querySelectorAll('.settings-sidebar .menu-item'))
      .filter(item => item.querySelector('.menu-label')?.textContent.trim() === '关于');
    if (matches.length !== 1) throw new Error('About sidebar unavailable');
    matches[0].click();
  }
  async function aboutReady(stage) {
    await wait(() => !!window.ztools?.internal && !!document.querySelector('.settings-sidebar .menu-item'));
    wrapFacade();
    navigateAbout();
    await wait(() => { failIf('version'); return typeof results.version === 'string' &&
      document.querySelector('.about-version')?.textContent === `v${results.version}` &&
      document.querySelector('#auto-check-update')?.checked === false && !!document.querySelector('.check-update-btn'); });
    const revision = window.__ATOOLS_SETTINGS_VIEW_CONFIG__?.bundleRevision;
    if (!/^[0-9a-f]{64}$/.test(revision ?? '') || calls.version !== 1 || calls.manual !== 0 || calls.auto !== 0) throw new Error('about ready observation invalid');
    await send(stage, dom(true), { ...emptyReceipt(), version: results.version, apiCalls: counts() });
  }
  async function manual() {
    const button = document.querySelector('.check-update-btn');
    if (!button || button.disabled || calls.manual !== 0) throw new Error('manual control unavailable');
    button.click();
    await wait(() => { failIf('manual'); return results.manual !== null && !button.disabled; });
    const value = results.manual;
    if (calls.version !== 1 || calls.manual !== 1 || calls.auto !== 0 || value.success !== true ||
        value.hasUpdate !== true || value.status !== 'available' || value.updateInfo?.version !== '99.78.0') throw new Error('manual result invalid');
    await send('about-manual', dom(true), { ...emptyReceipt(), manual: { success: true, hasUpdate: true, status: value.status, version: value.updateInfo.version }, apiCalls: counts() });
  }
  async function automatic(stage, enabled) {
    const input = document.querySelector('#auto-check-update');
    const expectedCount = enabled ? 1 : 2;
    if (!input || input.checked === enabled || calls.auto !== expectedCount - 1) throw new Error('automatic control unavailable');
    results.auto = null;
    input.click();
    await wait(() => { failIf('auto'); return calls.auto === expectedCount && results.auto !== null && input.checked === enabled; });
    const value = results.auto;
    if (!/^[0-9a-f]{32}$/.test(value.revision ?? '') || value.value?.autoCheckUpdate !== enabled ||
        value.notificationDelivered !== true || value.runtimeApplied !== true || value.runtimeError !== null ||
        calls.version !== 1 || calls.manual !== 1) throw new Error('automatic receipt invalid');
    await send(stage, dom(true), { ...emptyReceipt(), auto: { revision: value.revision, autoValue: value.value.autoCheckUpdate,
      notificationDelivered: value.notificationDelivered, runtimeApplied: value.runtimeApplied, runtimeError: value.runtimeError }, apiCalls: counts() });
  }
  async function run(stage) {
    const allowed = ['main-ready','about-ready','about-manual','popup-ready','auto-on','auto-off','about-reopened','popup-disposed','main-disposed'];
    if (!allowed.includes(stage)) throw new Error('unsupported about probe stage');
    try {
      if (stage === 'main-ready') {
        await wait(() => typeof window.ztools?.openSettings === 'function');
        const receipt = { dom: dom(true), receipt: { ...emptyReceipt(), negative: { badToken: true, wrongFrame: true } } };
        const badToken = await rejectedByHost(invoke('updater_about_observe', { token: '0'.repeat(32), stage, receipt }));
        const wrongFrame = await rejectedByHost(invoke('updater_about_observe', { token, stage: 'popup-ready', receipt: { dom: dom(true), receipt: null } }));
        if (!badToken || !wrongFrame) throw new Error('negative admission unexpectedly accepted');
        await send(stage, dom(true), { ...emptyReceipt(), negative: { badToken, wrongFrame } });
      } else if (stage === 'about-ready' || stage === 'about-reopened') await aboutReady(stage);
      else if (stage === 'about-manual') await manual();
      else if (stage === 'auto-on' || stage === 'auto-off') await automatic(stage, stage === 'auto-on');
      else if (stage === 'popup-ready') {
        await wait(() => document.querySelector('.title')?.textContent.includes('99.78.0') &&
          document.querySelector('.btn.confirm')?.disabled === false && typeof window.ztools?.updater?.startUpdate === 'function');
        await send(stage, dom(true), null);
      } else if (stage === 'popup-disposed') {
        const id = window.__ATOOLS_UPDATER_WINDOW_ID__;
        window.dispatchEvent(new Event('pagehide'));
        await wait(() => typeof window.ztools?.updater?.startUpdate !== 'function');
        await send(stage, dom(true, true), null);
        await withinDeadline(invoke('renderer_updater_window', { request: { op: 'close', windowId: id } }));
      } else if (stage === 'main-disposed') {
        window.dispatchEvent(new Event('pagehide'));
        await wait(() => { const state = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot(); return state?.disposed === true && state.outstandingNativeCalls === 0; });
        await send(stage, { ...dom(true, true), bridgePresent: false }, null);
      }
    } catch (error) {
      const failed = dom(false); failed.text = bounded(error?.message || 'about probe failed', 2048);
      await send(stage, failed, stage.startsWith('popup-') || stage === 'main-disposed' ? null : emptyReceipt());
    }
  }
  function openSettings() {
    if (typeof window.ztools?.openSettings !== 'function') throw new Error('Main Settings opener unavailable');
    return window.ztools.openSettings();
  }
  function closeSettings() {
    if (typeof window.ztools?.outPlugin !== 'function') throw new Error('Child close unavailable');
    return window.ztools.outPlugin();
  }
  Object.defineProperty(window, '__ATOOLS_UPDATER_ABOUT_NATIVE_PROBE__', { value: { run, openSettings, closeSettings }, configurable: false });
})();
