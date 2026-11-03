const FIXED_TEXT = "ATools synthetic clipboard text";
const FIXED_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD7sAAAAASUVORK5CYII=";
const FIXED_FILE = {
  path: "/fixture/clipboard-note.txt",
  name: "clipboard-note.txt",
  isFile: true,
  isDirectory: false,
};

function installRendererClipboardBrowserFixture(values) {
  const transport = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__;
  if (!transport || typeof transport.invoke !== "function") {
    throw new Error("Clipboard browser fixture requires the original renderer transport fixture");
  }
  const originalInvoke = transport.invoke.bind(transport);
  const url = new URL(window.location.href);
  const autoPaste = url.searchParams.get("clipboardAutoPaste") || "never";
  if (autoPaste !== "never" && autoPaste !== "1s") {
    throw new Error("Clipboard browser fixture accepts only fixed autoPaste modes");
  }
  const state = {
    autoPaste,
    settingsReads: 0,
    reads: [],
    expiredReads: 0,
    nextDelayMs: 0,
    contentKind: null,
    content: null,
    launchContextUpdates: 0,
    launchContext: null,
  };
  const contents = {
    text: { type: "text", data: values.text, ageMs: 0 },
    agedText: { type: "text", data: values.text, ageMs: 1500 },
    image: { type: "image", data: values.image, ageMs: 0 },
    file: { type: "file", data: [values.file], ageMs: 0 },
  };

  transport.invoke = async function invokeWithClipboard(command, args) {
    if (command === "get_ztools_renderer_settings") {
      const result = await originalInvoke(command, args);
      const general = JSON.parse(result.settings["settings-general"]);
      general.autoPaste = autoPaste;
      result.settings["settings-general"] = JSON.stringify(general);
      state.settingsReads += 1;
      return result;
    }
    if (command !== "get_renderer_last_copied_content") return originalInvoke(command, args);
    const keys = args && typeof args === "object" ? Object.keys(args) : [];
    if (keys.length !== 1 || keys[0] !== "timeLimit"
      || (args.timeLimit !== null && (typeof args.timeLimit !== "number" || !Number.isFinite(args.timeLimit) || args.timeLimit < 1))) {
      throw new Error("Clipboard browser fixture rejected the reader arguments");
    }
    if (state.nextDelayMs > 0) {
      const delayMs = state.nextDelayMs;
      state.nextDelayMs = 0;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    let returnedKind = state.content?.type ?? null;
    let expired = false;
    let result = null;
    let fileMetadataMatchesFixture = false;
    if (state.content) {
      const ageMs = Date.now() - state.content.timestamp;
      expired = args.timeLimit !== null && ageMs > args.timeLimit;
      if (expired) {
        state.expiredReads += 1;
        returnedKind = null;
      } else {
        result = {
          type: state.content.type,
          data: state.content.data,
          timestamp: state.content.timestamp,
        };
        fileMetadataMatchesFixture = result.type === "file"
          && result.data.length === 1
          && result.data[0].path === values.file.path
          && result.data[0].name === values.file.name
          && result.data[0].isFile === true
          && result.data[0].isDirectory === false;
      }
    }
    state.reads.push({ timeLimit: args.timeLimit, returnedKind, expired, fileMetadataMatchesFixture });
    return result;
  };

  const fixture = {
    setContent(kind) {
      const content = contents[kind];
      if (!content) throw new Error("Clipboard fixture accepts only its fixed content enum");
      state.contentKind = kind;
      state.content = {
        type: content.type,
        data: content.data,
        timestamp: Date.now() - content.ageMs,
      };
      return { kind, configured: true };
    },
    clear() {
      state.contentKind = null;
      state.content = null;
    },
    delayNextRead(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2000) {
        throw new Error("Clipboard fixture delay must be a fixed bounded integer");
      }
      state.nextDelayMs = milliseconds;
    },
    recordLaunchContext(context) {
      state.launchContextUpdates += 1;
      state.launchContext = {
        query: context.searchQuery,
        pastedTextMatchesFixture: context.pastedText === values.text,
        pastedImageMatchesFixture: context.pastedImage === values.image,
        pastedFileMatchesFixture: Array.isArray(context.pastedFiles)
          && context.pastedFiles.length === 1
          && context.pastedFiles[0].path === values.file.path
          && context.pastedFiles[0].name === values.file.name
          && context.pastedFiles[0].isDirectory === false,
        pastedKind: context.pastedImage !== null ? "image"
          : context.pastedFiles !== null ? "file"
            : context.pastedText !== null ? "text" : "none",
      };
    },
    snapshot() {
      return JSON.parse(JSON.stringify({
        autoPaste: state.autoPaste,
        settingsReads: state.settingsReads,
        readCount: state.reads.length,
        reads: state.reads,
        expiredReads: state.expiredReads,
        contentKind: state.contentKind,
        launchContextUpdates: state.launchContextUpdates,
        launchContext: state.launchContext,
      }));
    },
  };
  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__", {
    value: fixture, configurable: false, enumerable: false, writable: false,
  });
}

export function rendererClipboardBrowserFixtureScript() {
  return `(${installRendererClipboardBrowserFixture.toString()})(${JSON.stringify({
    text: FIXED_TEXT,
    image: FIXED_IMAGE,
    file: FIXED_FILE,
  })});`;
}

export const rendererClipboardBrowserFixtureValues = Object.freeze({
  text: FIXED_TEXT,
  image: FIXED_IMAGE,
  fileName: FIXED_FILE.name,
  fakeFilePath: FIXED_FILE.path,
});
