(() => {
  if (window.__ATOOLS_UPDATER_NATIVE_PROBE__) return;
  const token = "__UPDATER_NATIVE_TOKEN__";
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const wait = async test => {
    const end = performance.now() + 12000;
    while (!test()) {
      if (performance.now() >= end) throw Error('finite updater probe timed out');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  const dom = (ready, rejected = false) => ({
    ready, title: (document.querySelector('.title')?.textContent ?? '').slice(0, 100),
    text: (document.querySelector('.update-window')?.textContent ?? '').slice(0, 600),
    confirmDisabled: document.querySelector('.btn.confirm')?.disabled ?? null,
    cancelDisabled: document.querySelector('.btn.cancel')?.disabled ?? null,
    bridgePresent: typeof window.ztools?.updater?.startUpdate === 'function', rejected
  });
  const send = (stage, value) => invoke('updater_journey_observe', { token, stage, dom: value });
  async function run(stage) {
    try {
      if (stage === 'main-ready') {
        await wait(() => typeof window.ztools?.updater?.checkUpdate === 'function');
        const value = { ...dom(true), bridgePresent: true };
        const badToken = await invoke('updater_journey_observe', { token: '0'.repeat(32), stage, dom: value }).then(() => false, () => true);
        await send(stage, { ...value, rejected: badToken });
      } else if (stage === 'main-check') {
        const result = await window.ztools.updater.checkUpdate();
        const badSource = await invoke('updater_journey_observe', { token, stage: 'popup-ready', dom: dom(true) }).then(() => false, () => true);
        await send(stage, { ...dom(result.success === true && result.hasUpdate === true && result.updateInfo?.version === '99.78.0'), bridgePresent: true, rejected: badSource, text: result.updateInfo?.version ?? '' });
      } else if (stage === 'popup-ready') {
        await wait(() => document.querySelector('.title')?.textContent.includes('99.78.0') && document.querySelector('.btn.confirm')?.disabled === false && typeof window.ztools?.updater?.startUpdate === 'function');
        await send(stage, dom(true));
      } else if (stage === 'popup-busy') {
        window.__ATOOLS_UPDATER_NATIVE_PENDING__ = window.ztools.updater.startUpdate();
        await wait(() => document.querySelector('.btn.confirm')?.disabled === true && document.querySelector('.btn.cancel')?.disabled === true && document.querySelector('.update-window')?.textContent.includes('50%'));
        const rejected = await invoke('renderer_updater_window', { request: { op: 'close', windowId: window.__ATOOLS_UPDATER_WINDOW_ID__ } }).then(() => false, error => error?.code === 'busy');
        await send(stage, dom(true, rejected));
      } else if (stage === 'popup-error') {
        await window.__ATOOLS_UPDATER_NATIVE_PENDING__;
        delete window.__ATOOLS_UPDATER_NATIVE_PENDING__;
        await wait(() => document.querySelector('.btn.cancel')?.disabled === false && document.querySelector('.update-window')?.textContent.includes('下载失败'));
        await send(stage, dom(true));
      } else if (stage === 'popup-disposed') {
        const id = window.__ATOOLS_UPDATER_WINDOW_ID__;
        window.dispatchEvent(new Event('pagehide'));
        await send(stage, dom(typeof window.ztools?.updater?.startUpdate !== 'function'));
        await invoke('renderer_updater_window', { request: { op: 'close', windowId: id } });
      } else if (stage === 'main-disposed') {
        window.dispatchEvent(new Event('pagehide'));
        await wait(() => {
          const state = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot();
          return state?.disposed === true && state.outstandingNativeCalls === 0;
        });
        await send(stage, { ...dom(true), bridgePresent: false, text: 'disposed' });
      } else throw Error('unknown updater stage');
    } catch (error) {
      await send(stage, { ...dom(false), text: String(error?.message ?? error).slice(0, 600) });
    }
  }
  Object.defineProperty(window, '__ATOOLS_UPDATER_NATIVE_PROBE__', { value: { run }, configurable: false });
})()
