// Read-only Canvas projection and existing layout controls for the pinned original Image Stitch page.
(function () {
  var caseId = "local-image-stitch-head";
  var operations = ["state", "set-layout"];
  function visible(element) {
    if (!element || element.closest("[hidden],[inert]")) return false;
    for (var current = element; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function unique(selector) {
    var nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length !== 1 || !visible(nodes[0])) throw Error("Original Image Stitch control is missing, hidden or ambiguous");
    return nodes[0];
  }
  function uniqueVisibleRadioLabel(selector) {
    var radios = Array.from(document.querySelectorAll(selector));
    if (radios.length !== 1) throw Error("Original Image Stitch control is missing, hidden or ambiguous");
    var radio = radios[0], labels = Array.from(radio.labels || []);
    if (labels.length !== 1 || !visible(labels[0]) || !labels[0].contains(radio)) {
      throw Error("Original Image Stitch radio label is missing, hidden or ambiguous");
    }
    return { radio: radio, label: labels[0] };
  }
  function state() {
    var canvas = document.querySelector("#canvas"), placeholder = document.querySelector("#preview-placeholder");
    var items = Array.from(document.querySelectorAll("#image-list .image-item .image-info"));
    var direction = document.querySelector('input[name="direction"]:checked');
    var resize = document.querySelector("#resize-mode"), spacing = document.querySelector("#spacing"), padding = document.querySelector("#padding");
    var transparent = document.querySelector('.color-btn.active[data-color="transparent"]');
    var ready = !!canvas && !!placeholder && !!direction && !!resize && !!spacing && !!padding;
    try { uniqueVisibleRadioLabel('input[name="direction"][value="vertical"]'); unique("#resize-mode"); unique("#spacing"); unique("#padding"); unique("#btn-save"); }
    catch (_) { ready = false; }
    var pixels = [], pixelRead = false;
    if (canvas && canvas.width <= 2 && canvas.height <= 4 && canvas.width > 0 && canvas.height > 0) {
      try {
        var data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        for (var index = 0; index < data.length; index++) pixels.push(data[index]);
        pixelRead = true;
      } catch (_) { pixels = []; }
    }
    return { ready: ready, placeholderVisible: !!placeholder && visible(placeholder), canvasVisible: !!canvas && visible(canvas),
      imageCount: items.length, imageLabels: items.map(function (item) { return (item.textContent || "").trim().slice(0, 96); }),
      direction: direction ? direction.value : "", resizeMode: resize ? resize.value : "",
      spacing: spacing ? spacing.value : "", padding: padding ? padding.value : "", transparentBackground: !!transparent,
      canvasWidth: canvas ? canvas.width : 0, canvasHeight: canvas ? canvas.height : 0, pixelRead: pixelRead, rgba: pixels };
  }
  function authorized(operation, envelope) {
    if (window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ !== caseId || !operations.includes(operation)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return envelope && typeof envelope === "object" && !Array.isArray(envelope)
      && Object.keys(envelope).length === keys.length && Object.keys(envelope).every(function (key) { return keys.includes(key); })
      && envelope.kind === "atools-published-probe" && envelope.caseId === caseId && envelope.operation === operation
      && typeof envelope.token === "string" && envelope.token.length > 0 && envelope.token.length <= 128
      && typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 128
      && typeof envelope.documentNonce === "string" && /^[a-f0-9]{32}$/.test(envelope.documentNonce)
      && Array.isArray(envelope.workerLeaseSessions) && envelope.workerLeaseSessions.length === 0;
  }
  function perform(operation, envelope) {
    if (!authorized(operation, envelope)) throw Error("Unapproved original Image Stitch UI operation");
    if (operation === "set-layout") {
      var vertical = uniqueVisibleRadioLabel('input[name="direction"][value="vertical"]');
      var resize = unique("#resize-mode"), spacing = unique("#spacing"), padding = unique("#padding");
      if (!vertical.radio.checked) vertical.label.click();
      if (!vertical.radio.checked) throw Error("Original Image Stitch vertical layout label did not select its radio");
      resize.value = "none"; resize.dispatchEvent(new Event("change", { bubbles: true }));
      spacing.value = "0"; spacing.dispatchEvent(new Event("input", { bubbles: true }));
      padding.value = "0"; padding.dispatchEvent(new Event("input", { bubbles: true }));
      var transparent = document.querySelector('.color-btn[data-color="transparent"]');
      if (!transparent || !visible(transparent)) throw Error("Original Image Stitch transparent-background control is unavailable");
      if (!transparent.classList.contains("active")) transparent.click();
    }
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    get caseId() { return window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ === caseId ? caseId : null; }, state: state, perform: perform
  };
})();
