import assert from "node:assert/strict";
import { rendererClipboardBrowserFixtureValues } from "./ztools-renderer-clipboard-browser-fixture.mjs";

const FIXED_TEXT = rendererClipboardBrowserFixtureValues.text;
const FIXED_FILE_NAME = rendererClipboardBrowserFixtureValues.fileName;
const FIXED_TEXT_PREVIEW = `${FIXED_TEXT.slice(0, 15)}...${FIXED_TEXT.slice(-10)}`;

export function createZtoolsRendererClipboardBrowserJourney({
  page,
  evaluate,
  waitFor,
  settleRequests,
  origin,
  setDocumentKey,
  captureScreenshot,
  checks,
}) {
  async function clipboardState() {
    return evaluate("window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot() ?? null");
  }

  async function setClipboard(kind) {
    const result = await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.setContent(${JSON.stringify(kind)})`);
    assert.equal(result?.configured, true, `Fixed clipboard fixture content ${kind} was not installed`);
  }

  async function dispatchPaste() {
    return evaluate(`(() => {
      const input = document.querySelector('.search-input');
      if (!input) return null;
      input.focus();
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      const defaultActionAllowed = input.dispatchEvent(event);
      return { defaultActionAllowed, defaultPrevented: event.defaultPrevented };
    })()`);
  }

  async function launchContext() {
    return evaluate("window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.launchContext ?? null");
  }

  async function run() {
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    const loaded = page.waitForEvent("Page.loadEventFired", 20000);
    setDocumentKey("clipboard-original-vue");
    await page.send("Page.navigate", {
      url: `${origin}/?color=blue&scheme=dark&autoClear=never&clipboardAutoPaste=1s&holdRendererStartup=1`,
    }, { timeoutMs: 10000 });
    await loaded;
    await waitFor("document.querySelector('.search-input') && document.querySelector('.app-container')");
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot()?.startupHeld === true
      && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot()?.activeListenersByEvent['atools://renderer-general-settings'] === 1
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.settingsReads === 1`);
    const earlyPolicy = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitAutoPaste('off')");
    assert.equal(earlyPolicy.delivered, 1);
    assert.deepEqual(await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.releaseStartup()"), { released: true });
    await waitFor(`(() => {
      const fixture = window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot();
      const base = window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot();
      const adapter = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot();
      return fixture?.autoPaste === '1s' && fixture.settingsReads === 1
        && base?.settingsBatchLoads === 1
        && base.activeListenersByEvent['tauri://focus'] === 1
        && adapter?.focusEvents?.listenerState === 'listening';
    })()`);
    await settleRequests();
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().updaterStatusReads === 1");
    await setClipboard("text");
    assert.equal(await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitFocus()"), 1);
    const startupPolicy = await clipboardState();
    assert.equal(startupPolicy.readCount, 0, "An autoPaste=off event received while the original Main awaits its catalog must survive late subscription");

    const hookInstalled = await evaluate(`(() => {
      const api = window.ztools;
      const fixture = window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__;
      if (!api || typeof api.updateLaunchContext !== 'function' || !fixture) return false;
      const original = api.updateLaunchContext;
      api.updateLaunchContext = function observeRealLaunchContext(value) {
        const result = original.call(this, value);
        fixture.recordLaunchContext(value);
        return result;
      };
      return api.updateLaunchContext !== original;
    })()`);
    assert.equal(hookInstalled, true, "The real updateLaunchContext method must remain the source of launch context");

    const initialInput = await evaluate("document.querySelector('.search-input')?.value ?? null");
    assert.equal(initialInput, "", "Clipboard journey must start with an empty original search input");
    await setClipboard("text");
    const textPaste = await dispatchPaste();
    assert.deepEqual(textPaste, { defaultActionAllowed: false, defaultPrevented: true }, "Original SearchBox must cancel the default action of the actual paste event");
    await waitFor(`document.querySelector('.pasted-text .text-content')?.textContent === ${JSON.stringify(FIXED_TEXT_PREVIEW)}
      && document.querySelector('.search-input')?.value === ''
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.readCount === 1`);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.launchContext?.pastedTextMatchesFixture === true");
    const emptyText = await launchContext();
    assert.equal(emptyText.query, "");
    assert.equal(emptyText.pastedKind, "text");
    await captureScreenshot("clipboard-empty-text-chip");

    await evaluate("document.querySelector('.pasted-text')?.click()");
    await waitFor(`document.querySelector('.search-input')?.value === ${JSON.stringify(FIXED_TEXT)} && !document.querySelector('.pasted-text')`);
    await evaluate(`(() => {
      const input = document.querySelector('.search-input');
      input.focus();
      input.setSelectionRange(0, input.value.length);
    })()`);
    await page.send("Input.insertText", { text: "alpha omega" });
    await waitFor("document.querySelector('.search-input')?.value === 'alpha omega'");
    await evaluate("document.querySelector('.search-input')?.setSelectionRange(6, 11)");
    await setClipboard("text");
    const selectionPaste = await dispatchPaste();
    assert.deepEqual(selectionPaste, { defaultActionAllowed: false, defaultPrevented: true });
    const selectedQuery = `alpha ${FIXED_TEXT}`;
    await waitFor(`document.querySelector('.search-input')?.value === ${JSON.stringify(selectedQuery)}
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.readCount === 2`);
    const selectedText = await launchContext();
    assert.equal(selectedText.query, selectedQuery);
    assert.equal(selectedText.pastedKind, "none");
    await captureScreenshot("clipboard-selection-insert");

    await setClipboard("image");
    const imagePaste = await dispatchPaste();
    assert.deepEqual(imagePaste, { defaultActionAllowed: false, defaultPrevented: true });
    await waitFor(`document.querySelector('.pasted-image-thumbnail img')?.getAttribute('src')?.startsWith('data:image/png;base64,')
      && document.querySelector('.pasted-image-thumbnail img')?.complete
      && document.querySelector('.pasted-image-thumbnail img')?.naturalWidth === 1
      && document.querySelector('.pasted-image-thumbnail img')?.naturalHeight === 1
      && document.querySelector('.search-input')?.value === ''
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.readCount === 3`);
    const imageContext = await launchContext();
    assert.equal(imageContext.pastedKind, "image");
    assert.equal(imageContext.pastedImageMatchesFixture, true);
    await captureScreenshot("clipboard-image-chip");

    await setClipboard("file");
    const filePaste = await dispatchPaste();
    assert.deepEqual(filePaste, { defaultActionAllowed: false, defaultPrevented: true });
    await waitFor(`document.querySelector('.pasted-files .file-name')?.textContent === ${JSON.stringify(FIXED_FILE_NAME)}
      && !document.querySelector('.pasted-image-thumbnail')
      && document.querySelector('.search-input')?.value === ''
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.readCount === 4`);
    const fileContext = await launchContext();
    const fileRead = await clipboardState();
    assert.equal(fileContext.pastedKind, "file");
    assert.equal(fileContext.pastedFileMatchesFixture, true);
    assert.equal(fileRead.reads.at(-1)?.fileMetadataMatchesFixture, true,
      "The fake file response must retain its fixed absolute path and file/directory metadata");
    await captureScreenshot("clipboard-file-chip");

    const beforeFocus = await launchContext();
    await updateAutoPaste("1s");
    await setClipboard("agedText");
    const deliveredFocusCallbacks = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.emitFocus() ?? 0");
    assert.ok(deliveredFocusCallbacks >= 1, "Original focus callback must receive the synthetic fixture event");
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.readCount === 5");
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot()?.expiredReads === 1");
    const final = await clipboardState();
    const afterFocus = final.launchContext;
    assert.equal(final.autoPaste, "1s");
    assert.equal(final.reads.at(-1)?.timeLimit, 1000, "Original focus handling must pass the configured one-second limit");
    assert.equal(final.reads.at(-1)?.returnedKind, null, "Expired fixture content must be returned as null");
    assert.deepEqual(afterFocus, beforeFocus, "Expired auto-paste must preserve the existing original launch context");
    await captureScreenshot("clipboard-expired-focus-preserves-context");

    async function updateAutoPaste(value) {
      const notification = await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitAutoPaste(${JSON.stringify(value)})`);
      assert.equal(notification?.value, value);
      assert.equal(notification.delivered, 1, "Policy updates must reuse the single General event listener");
    }

    async function focusSearch() {
      const callbacks = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitFocus()");
      assert.equal(callbacks, 1, "The real App.vue focus handler must receive the fixture event once");
    }

    await setClipboard("text");
    await updateAutoPaste("off");
    const beforeOff = await clipboardState();
    await focusSearch();
    const disabled = await clipboardState();
    assert.equal(disabled.readCount, beforeOff.readCount, "off must stop the original focus callback from reading");
    assert.deepEqual(disabled.launchContext, beforeOff.launchContext);

    await updateAutoPaste("3s");
    await focusSearch();
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.snapshot().readCount === ${disabled.readCount + 1}
      && window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.snapshot().launchContext?.pastedTextMatchesFixture === true`);
    const enabled = await clipboardState();
    assert.equal(enabled.reads.at(-1).timeLimit, 3000);
    assert.equal(enabled.reads.at(-1).returnedKind, "text");
    await captureScreenshot("clipboard-runtime-auto-paste-enabled");

    await updateAutoPaste("off");
    await focusSearch();
    const disabledAgain = await clipboardState();
    assert.equal(disabledAgain.readCount, enabled.readCount);
    assert.deepEqual(disabledAgain.launchContext, enabled.launchContext);
    assert.deepEqual(await dispatchPaste(), { defaultActionAllowed: false, defaultPrevented: true });
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.snapshot().readCount === ${enabled.readCount + 1}`);
    const manualWhileOff = await clipboardState();
    assert.equal(manualWhileOff.reads.at(-1).timeLimit, null, "Manual paste must still use its unlimited explicit read while off");
    assert.equal(manualWhileOff.reads.at(-1).returnedKind, "text");
    await captureScreenshot("clipboard-runtime-off-manual-paste");

    const runtimeLimits = [{ setting: "3s", timeLimit: 3000 }];
    for (const [setting, expected] of [["1s", 1000], ["5s", 5000], ["10s", 10000]]) {
      await setClipboard("text");
      await updateAutoPaste(setting);
      const before = await clipboardState();
      await focusSearch();
      await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.snapshot().readCount === ${before.readCount + 1}`);
      const actual = await clipboardState();
      assert.equal(actual.reads.at(-1).timeLimit, expected);
      assert.equal(actual.reads.at(-1).returnedKind, "text");
      runtimeLimits.push({ setting, timeLimit: actual.reads.at(-1).timeLimit });
    }
    await updateAutoPaste("1s");
    await setClipboard("agedText");
    const beforeRuntimeExpiry = await clipboardState();
    await focusSearch();
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__.snapshot().readCount === ${beforeRuntimeExpiry.readCount + 1}`);
    const afterRuntimeExpiry = await clipboardState();
    assert.equal(afterRuntimeExpiry.reads.at(-1).timeLimit, 1000);
    assert.equal(afterRuntimeExpiry.reads.at(-1).returnedKind, null);
    assert.equal(afterRuntimeExpiry.reads.at(-1).expired, true);
    assert.deepEqual(afterRuntimeExpiry.launchContext, beforeRuntimeExpiry.launchContext);
    await updateAutoPaste("off");
    const runtimeFinal = await clipboardState();

    const result = {
      documentKey: "clipboard-original-vue",
      fixtureKind: "synthetic-native-transport",
      native: false,
      rust: false,
      osClipboard: false,
      originalSearchBoxPasteEvent: true,
      originalUpdateLaunchContextCalled: true,
      cases: {
        emptyText: { defaultPrevented: textPaste.defaultPrevented, chipVisible: true, launchContextMatched: true },
        selectedText: { defaultPrevented: selectionPaste.defaultPrevented, queryInserted: selectedText.query === selectedQuery },
        image: { defaultPrevented: imagePaste.defaultPrevented, chipVisible: imageContext.pastedImageMatchesFixture, decodedDimensions: [1, 1] },
        file: {
          defaultPrevented: filePaste.defaultPrevented,
          chipVisible: fileContext.pastedFileMatchesFixture,
          metadataMatched: fileRead.reads.at(-1).fileMetadataMatchesFixture,
        },
      },
      autoPaste: {
        setting: final.autoPaste,
        focusCallbacks: deliveredFocusCallbacks,
        timeLimit: final.reads.at(-1).timeLimit,
        expiredReturnedNull: final.reads.at(-1).expired && final.reads.at(-1).returnedKind === null,
        priorLaunchContextPreserved: JSON.stringify(beforeFocus) === JSON.stringify(afterFocus),
      },
      runtimeAutoPaste: {
        notifications: "synthetic General settings event; original App.vue/windowStore consumers",
        startupEventSurvivedLateSubscription: startupPolicy.readCount === 0,
        offDoesNotRead: disabled.readCount === beforeOff.readCount,
        reenabledReadsText: enabled.reads.at(-1).returnedKind === "text",
        disabledAgainDoesNotRead: disabledAgain.readCount === enabled.readCount,
        manualWhileOff: manualWhileOff.reads.at(-1).timeLimit === null,
        positiveLimits: runtimeLimits,
        runtimeExpiredReturnedNull: afterRuntimeExpiry.reads.at(-1).expired && afterRuntimeExpiry.reads.at(-1).returnedKind === null,
        runtimeExpiredPreservedContext: JSON.stringify(afterRuntimeExpiry.launchContext) === JSON.stringify(beforeRuntimeExpiry.launchContext),
        finalPolicy: "off",
      },
      readSummary: { count: runtimeFinal.readCount, timeLimits: runtimeFinal.reads.map(read => read.timeLimit), expired: runtimeFinal.expiredReads },
      screenshots: [
        "clipboard-empty-text-chip.png", "clipboard-selection-insert.png", "clipboard-image-chip.png",
        "clipboard-file-chip.png", "clipboard-expired-focus-preserves-context.png",
        "clipboard-runtime-auto-paste-enabled.png", "clipboard-runtime-off-manual-paste.png",
      ],
    };
    checks.push("The pinned original SearchBox handled synthetic text/image/file paste events through the typed clipboard reader, and real updateLaunchContext calls received fixed fixture summaries");
    checks.push("A fresh autoPaste=1s document passed timeLimit=1000 on its real focus callback; expired synthetic content returned null and preserved launch context");
    checks.push("The original Main consumed runtime General autoPaste notifications off→3s→off, all positive time limits, expiry preservation and manual paste while off through one existing event listener");
    checks.push("An early off notification delivered while the original Main awaited its catalog survived late callback registration and prevented the first automatic read");
    return result;
  }

  return Object.freeze({ run });
}
