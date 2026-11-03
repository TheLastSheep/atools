(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__";
  const replies = new Map();
  const pixelPng = (color, width, height) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, width, height);
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), "image/png"));
  };
  const file = async (name, color, width, height) => new File([await pixelPng(color, width, height)], name, { type: "image/png" });
  const waitForImageItems = async expected => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (document.querySelectorAll(".image-item").length === expected) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error("ImageDropNotReady");
  };
  const dropImage = async (name, color, width, height, expectedCount) => {
    const item = await file(name, color, width, height);
    const transfer = new DataTransfer(); transfer.items.add(item);
    const target = document.querySelector("#preview-area");
    if (!target) throw Error("ImageDropTargetMissing");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    await waitForImageItems(expectedCount);
  };
  const dropImages = async () => {
    await dropImage("synthetic-red.png", "#ff0000", 2, 1, 1);
    await dropImage("synthetic-blue.png", "#0000ff", 1, 2, 2);
  };
  const change = (selector, value, event = "change") => {
    const element = document.querySelector(selector); if (!element) throw Error("ImageSettingMissing");
    if (element.type === "radio") element.checked = true; else element.value = value;
    element.dispatchEvent(new Event(event, { bubbles: true }));
  };
  const waitCanvas = async () => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const canvas = document.querySelector("#canvas");
      if (canvas?.width > 0 && canvas?.height > 0 && document.querySelectorAll(".image-item").length >= 2) return canvas;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error("ImageCanvasNotReady");
  };
  const inspect = async () => {
    const canvas = await waitCanvas(), ctx = canvas.getContext("2d");
    const rgba = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    return { width: canvas.width, height: canvas.height,
      redAt1x1: rgba(1, 1), whiteAt1x2: rgba(1, 2), blueAt1x3: rgba(1, 3),
      blueAt1x1: rgba(1, 1), whiteAt2x1: rgba(2, 1), redAt3x1: rgba(3, 1),
      blueAt4x1: rgba(4, 1), whiteAt3x1: rgba(3, 1), hasNativeFilePath: typeof window.ztools?.getPathForFile === "function" };
  };
  async function run(operation) {
    switch (operation) {
      case "state": {
        const nodeRequire = typeof window.require === "function";
        let processObserved = false, fsWriteAvailable = false, bufferAvailable = false;
        try { processObserved = Number.isInteger(window.require("process").pid) && window.require("process").pid > 0; } catch {}
        try { fsWriteAvailable = typeof window.require("fs").writeFileSync === "function"; } catch {}
        try { bufferAvailable = typeof window.Buffer?.from === "function"; } catch {}
        return { ready: !!document.querySelector("#image-list"), opaque: location.origin === "null",
          noTauri: !("__TAURI_INTERNALS__" in window), nodeRequire, fsWriteAvailable, bufferAvailable, processObserved };
      }
      case "image-vertical":
        change('input[name="direction"][value="vertical"]', "vertical"); change("#resize-mode", "none");
        change("#align", "start"); change("#spacing", "1", "input"); change("#padding", "1", "input");
        document.querySelector('.color-btn[data-color="#ffffff"]')?.click(); await dropImages(); return inspect();
      case "image-horizontal":
        change('input[name="direction"][value="horizontal"]', "horizontal"); await waitCanvas(); return inspect();
      case "image-reverse":
        document.querySelector("#btn-reverse")?.click();
        return inspect();
      case "image-clear":
        document.querySelector("#btn-clear")?.click();
        return { cleared: !document.querySelector("#image-list .image-item") && getComputedStyle(document.querySelector("#preview-placeholder")).display !== "none" };
      case "save-cancel": {
        window.__AToolsNodePageSaveFixture.cancel();
        return { dialogCount: window.__AToolsNodePageMock.records.filter(item => item.kind === "save-dialog").length,
          canceled: window.__AToolsNodePageMock.records.at(-1)?.cancel === true,
          revealCount: window.__AToolsNodePageMock.records.filter(item => item.kind === "reveal").length };
      }
      case "save-write": {
        window.__AToolsNodePageSaveFixture.setState([{}], "png"); window.__AToolsNodePageSaveFixture.write();
        const records = window.__AToolsNodePageMock.records;
        return { dialogCount: records.filter(item => item.kind === "save-dialog").length,
          successNotification: records.some(item => item.kind === "notification" && item.success),
          revealMatched: records.some(item => item.kind === "reveal" && item.matched) };
      }
      case "codec-state": {
        // The pure-Web compatibility shim has function-shaped fs stubs. Their
        // presence does not establish a real Node session or usable file I/O.
        let processAvailable = false;
        try { processAvailable = Number.isInteger(window.require("process")?.pid); } catch {}
        return { ready: !!document.querySelector("#operation")?.options?.length, noTauri: !("__TAURI_INTERNALS__" in window),
          nodeRuntimeAccess: processAvailable || typeof window.__atoolsNodeModuleRequire === "function",
          output: document.querySelector("#outputText")?.value || "" };
      }
      case "codec-roundtrip": {
        const op = document.querySelector("#operation"), input = document.querySelector("#inputText");
        if (!op || !input) throw Error("CodecUiMissing");
        op.value = "base64-encode"; op.dispatchEvent(new Event("change", { bubbles: true }));
        input.value = "ATools 编码✓"; input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#runOperation")?.click(); await new Promise(resolve => setTimeout(resolve, 20));
        const encoded = document.querySelector("#outputText")?.value || "";
        op.value = "base64-decode"; op.dispatchEvent(new Event("change", { bubbles: true }));
        input.value = encoded; input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#runOperation")?.click(); await new Promise(resolve => setTimeout(resolve, 20));
        return { encoded, decoded: document.querySelector("#outputText")?.value || "", status: document.querySelector("#statusLine")?.textContent || "" };
      }
      case "codec-invalid": {
        const op = document.querySelector("#operation"), input = document.querySelector("#inputText");
        if (!op || !input) throw Error("CodecUiMissing");
        op.value = "base64-decode"; op.dispatchEvent(new Event("change", { bubbles: true }));
        input.value = "%%%"; input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#runOperation")?.click(); await new Promise(resolve => setTimeout(resolve, 20));
        return { errorClass: !!document.querySelector("#statusLine.error"), status: document.querySelector("#statusLine")?.textContent || "" };
      }
      default: throw Error("UnreviewedNodePageOperation");
    }
  }
  window.addEventListener("message", async event => {
    const message = event.data;
    if (event.source !== parent || message?.kind !== "atools-node-page-probe" || message.token !== token
      || typeof message.id !== "string" || replies.has(message.id)) return;
    replies.set(message.id, true); let result = {}, error = "";
    try { result = await run(message.operation); } catch (failure) { error = String(failure?.name || "FixtureOperationError"); }
    parent.postMessage({ kind: "atools-node-page-result", token, id: message.id, result, error }, "*");
  });
})();
