(() => {
  const state = document.getElementById("fixture-state");
  let lastOption, lastPayload;
  // These startup calls must not take focus from the launcher or abort registration.
  window.focus();
  document.getElementById("startup-focus").focus();
  window.ztools.onPluginReady(() => { state.dataset.ready = String(Number(state.dataset.ready) + 1); });
  window.ztools.onMainPush(async ({ code, type, payload }) => {
    state.dataset.query = String(Number(state.dataset.query) + 1);
    lastPayload = payload;
    lastOption = { text: "Fixture same-page selection", marker: "main-push-private-option-4513c9",
      nested: { code, type, payload }, serial: Number(state.dataset.query) };
    await new Promise(resolve => setTimeout(resolve, 25));
    return { type: "list", data: [lastOption] };
  }, ({ option, payload }) => {
    if (option !== lastOption || payload !== lastPayload || option.nested.payload !== payload) {
      throw Error("Original option closure was replaced");
    }
    state.dataset.select = String(Number(state.dataset.select) + 1);
    state.dataset.selectionVerified = "true";
    return true;
  });
  window.ztools.onPluginEnter(action => {
    state.dataset.enter = String(Number(state.dataset.enter) + 1);
    state.dataset.enterOptionVerified = String(action.option === lastOption && action.payload === lastPayload);
    state.textContent = "entered with the original option closure";
  });
})();
