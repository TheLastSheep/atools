/* Read-only observer installed only by the opt-in isolated native fixture. */
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_MAIN_PUSH_TOKEN__";
  const documentId = crypto.randomUUID();
  let promotions = 0;
  addEventListener("atools-main-push-promote", () => { promotions++; });
  addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || !data || data.__nativeMainPushObserve !== true
      || data.token !== token || typeof data.requestId !== "string" || data.requestId.length > 64) return;
    const fixture = document.getElementById("fixture-state");
    parent.postMessage({ __nativeMainPushObservation: true, token, requestId: data.requestId,
      observation: { documentId, promotions, visibility: document.visibilityState,
        hasFocus: document.hasFocus(), activeTag: document.activeElement?.tagName ?? null,
        textareaValues: [...document.querySelectorAll("textarea")].slice(0, 4).map(node => node.value.slice(0, 4096)),
        fixture: fixture ? { ready: fixture.dataset.ready, query: fixture.dataset.query,
          select: fixture.dataset.select, enter: fixture.dataset.enter,
          selectionVerified: fixture.dataset.selectionVerified ?? null,
          enterOptionVerified: fixture.dataset.enterOptionVerified ?? null, text: fixture.textContent?.slice(0, 256) } : null,
      } }, "*");
  });
})();
