import assert from "node:assert/strict";

/** Exercises the real source-manifest choice UI with a strict synthetic inspect TaskRun. */
export async function verifySourceManifestChoices({ evaluate, waitFor, fixture, key, click, clickButton, wheel, setViewport, screenshot, assertNoOverflow }) {
  const sourcePath = "/fixture/source/blocked";
  const resetScanKey = "source-manifest-default-candidates";
  const sourceInputId = `ztools-import-${encodeURIComponent(sourcePath)}`;
  const sourceRow = `Array.from(document.querySelectorAll('.candidate-row')).find(row => row.querySelector('.candidate-path')?.textContent?.trim() === ${JSON.stringify(sourcePath)})`;
  const sourceRowSelector = `.candidate-row:has(input[id=${JSON.stringify(sourceInputId)}])`;
  const sourceChoices = `${sourceRow}?.querySelector('.manifest-choices')`;
  const selectedManifestLabel = `${sourceRow}?.querySelector('.manifest-choices .selected-label') ?? null`;
  const choiceButton = selection => `${sourceRowSelector} .manifest-choices article:nth-child(${selection === "root" ? 1 : 2}) button`;
  const clippedVisibility = `(element) => {
    const rect = element.getBoundingClientRect();
    const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const clips = value => ['hidden', 'clip', 'scroll', 'auto', 'overlay'].includes(value);
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!clips(style.overflowX) && !clips(style.overflowY)) continue;
      const box = ancestor.getBoundingClientRect();
      const left = box.left + ancestor.clientLeft;
      const top = box.top + ancestor.clientTop;
      if (clips(style.overflowX)) {
        bounds.left = Math.max(bounds.left, left);
        bounds.right = Math.min(bounds.right, left + ancestor.clientWidth);
      }
      if (clips(style.overflowY)) {
        bounds.top = Math.max(bounds.top, top);
        bounds.bottom = Math.min(bounds.bottom, top + ancestor.clientHeight);
      }
    }
    bounds.width = Math.max(0, bounds.right - bounds.left);
    bounds.height = Math.max(0, bounds.bottom - bounds.top);
    const fullyVisible = rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    return { fullyVisible, clipBounds: bounds };
  }`;
  const state = () => evaluate(`(() => {
    const clippedVisibility = ${clippedVisibility};
    const sourceRow = ${sourceRow};
    const articles = Array.from(sourceRow?.querySelectorAll('.manifest-choices article') ?? []);
    const choices = articles.map(article => {
      const visibility = clippedVisibility(article);
      const versionRow = Array.from(article.querySelectorAll('dl div'))
        .find(row => row.querySelector('dt')?.textContent === '版本');
      const button = article.querySelector('button');
      return {
        label: article.querySelector('strong')?.textContent?.trim(),
        path: article.querySelector('.manifest-path')?.textContent?.trim(),
        version: versionRow?.querySelector('dd')?.textContent?.trim(),
        selected: article.classList.contains('selected'),
        button: button?.textContent?.trim() || null,
        disabled: button?.disabled ?? null,
        visible: visibility.fullyVisible,
        clipBounds: visibility.clipBounds,
      };
    });
    const active = document.activeElement;
    const sourceBuild = sourceRow?.querySelector('.source-build');
    const convertButtons = Array.from(sourceRow?.querySelectorAll('.source-build button') ?? [])
      .filter(button => button.textContent.trim() === '一键转换并安装')
      .map(button => ({ disabled: button.disabled }));
    const selectedLabel = sourceRow?.querySelector('.manifest-choices article.selected .selected-label') ?? null;
    const conversionAction = Array.from(sourceRow?.querySelectorAll('.source-build button') ?? [])
      .find(button => button.textContent.trim() === '一键转换并安装') ?? null;
    const inspectButtons = Array.from(sourceRow?.querySelectorAll('.source-build .actions button') ?? [])
      .map(button => ({ text: button.textContent.trim(), disabled: button.disabled }));
    return {
      candidatePath: sourceRow?.querySelector('.candidate-path')?.textContent?.trim() ?? null,
      rowText: sourceRow?.innerText || '',
      checkboxDisabled: sourceRow?.querySelector('input')?.disabled ?? null,
      convertButtons,
      selectedLabel: selectedLabel ? { text: selectedLabel.textContent?.trim() ?? null, ...clippedVisibility(selectedLabel) } : null,
      conversionAction: conversionAction ? { disabled: conversionAction.disabled, ...clippedVisibility(conversionAction) } : null,
      inspectButtons,
      sourceBuildBusy: sourceBuild?.getAttribute('aria-busy') ?? null,
      sourceBuildStatus: sourceBuild?.querySelector('[role=status]')?.textContent?.trim() ?? null,
      choices,
      active: {
        tag: active?.tagName,
        id: active?.id || null,
        text: active?.textContent?.trim() || null,
        outline: getComputedStyle(active).outlineStyle,
        outlineWidth: getComputedStyle(active).outlineWidth,
      },
    };
  })()`);
  const inspections = () => fixture("sourceManifestInspections");
  const waitForInspectionCount = async count => waitFor(`window.pluginImportTransactionFixture.sourceManifestInspections.length===${count}`);
  async function tabTo(selector) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return;
      await key("Tab", "Tab", 9);
    }
    assert.fail(`Natural Tab navigation did not reach ${selector}`);
  }
  async function requestWithKeyboard(selection, pendingKey) {
    const selector = choiceButton(selection);
    await fixture(`planSourceInspection(${JSON.stringify(pendingKey)})`);
    await click("[data-atools-search-input]");
    await tabTo(selector);
    const focused = await evaluate(`(()=>{const clippedVisibility=${clippedVisibility};const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e);return {active:document.activeElement===e,outline:s.outlineStyle,width:s.outlineWidth,...clippedVisibility(e)}})()`);
    assert.equal(focused.active, true);
    assert.equal(focused.fullyVisible, true, `Naturally focused manifest choice is clipped by a scroll ancestor or viewport: ${JSON.stringify(focused)}`);
    assert.notEqual(focused.outline, "none", `Manifest choice lacks visible keyboard focus: ${JSON.stringify(focused)}`);
    await key(" ", "Space", 32);
    await waitForInspectionCount(selection === "root" ? 2 : 3);
    await waitFor(`${sourceRow}?.querySelector('.source-build[aria-busy="true"] [role=status]')?.textContent.includes('正在检查本地转换条件')`);
    const pending = await state();
    assert.equal(pending.sourceBuildBusy, "true", "The selected source build action is visibly pending");
    assert.match(pending.sourceBuildStatus, /正在检查本地转换条件/, "The held start_agent_tool request remains in the actual checking phase");
    assert.deepEqual(pending.convertButtons, [], "Conversion stays unavailable while the selected manifest is being re-inspected");
    assert.equal(await evaluate(selectedManifestLabel), null, "Prior inspection is no longer presented as confirmed");
    await fixture(`resolveSourceInspection(${JSON.stringify(pendingKey)})`);
    await waitFor(`${sourceRow}?.querySelector('.manifest-choices article.selected .selected-label')?.textContent.includes('已按所选清单重新检查')`);
    return { focused, pending, afterSpace: await state() };
  }

  await setViewport(900, 760, "light");
  await fixture(`planScan('scan_default_ztools_plugins',${JSON.stringify(resetScanKey)})`);
  await clickButton("扫描 ZTools");
  await waitFor(`window.pluginImportTransactionFixture.calls.some(call=>call.command==='scan_default_ztools_plugins'&&call.pendingKey===${JSON.stringify(resetScanKey)})`);
  await fixture(`resolveScan(${JSON.stringify(resetScanKey)})`);
  await waitFor(`${sourceRow} && !document.querySelector('.busy-line')`);
  const targetRowVisible = await evaluate(`(()=>{const row=${sourceRow};if(!row)return false;row.scrollIntoView({block:'start'});return true})()`);
  assert.equal(targetRowVisible, true, `The scanned source row is missing: ${sourcePath}`);
  const beforeInspection = await state();
  assert.equal(beforeInspection.candidatePath, sourcePath, "The provisional version belongs to the exact source path under test");
  assert.match(beforeInspection.rowText, /扫描摘要版本 1\.0\.0/, "The scanned version is explicitly provisional, not a selected manifest identity");
  assert.equal(beforeInspection.checkboxDisabled, true);
  assert.deepEqual(beforeInspection.convertButtons, []);
  assert.deepEqual(beforeInspection.inspectButtons, [{ text: "检查可转换版本", disabled: false }], "The exact blocked source row exposes the intended provisional inspection action");
  const precheckShot = await screenshot("manifest-choice-precheck-900-light");
  await click(`${sourceRowSelector} .source-build .actions button`);
  await waitForInspectionCount(1);
  await waitFor(`${sourceRow}?.querySelectorAll('.manifest-choices article').length===2 && ${sourceRow}?.querySelector('.manifest-choices .difference')`);
  await evaluate(`${sourceChoices}?.scrollIntoView({block:'start'})`);
  const initial = await state();
  assert.deepEqual(initial.choices.map(({ label, path, version, selected }) => ({ label, path, version, selected })), [
    { label: "项目根目录", path: "plugin.json", version: "1.4.0", selected: false },
    { label: "发布目录", path: "public/plugin.json", version: "0.9.0", selected: false },
  ]);
  assert.ok(initial.choices.every(choice => choice.visible), `Wide manifest choices are not fully visible: ${JSON.stringify(initial.choices)}`);
  assert.deepEqual(initial.convertButtons, []);
  const initialRun = (await inspections())[0];
  assert.deepEqual(initialRun.args, { name: "inspect_ztools_source_build", arguments: { sourcePath }, clientId: "atools-ui", confirmed: false });
  assert.equal(initialRun.response.id, initialRun.runId);
  assert.equal(initialRun.response.capabilityId, "inspect_ztools_source_build");
  assert.deepEqual(initialRun.response.initiator, { type: "human", clientId: "atools-ui" });
  assert.equal(initialRun.response.status, "succeeded");
  assert.deepEqual(initialRun.response.input, { sourcePath });
  assert.equal(initialRun.response.output.manifestSelection, null);
  assert.deepEqual(initialRun.response.output.manifestCandidates.map(candidate => candidate.manifestSha256), ["a".repeat(64), "b".repeat(64)]);
  const wide = await assertNoOverflow("manifest-choice-900x760-light");
  const wideShot = await screenshot("manifest-choice-two-versions-900-light");

  const rootChoice = await requestWithKeyboard("root", "root-manifest-recheck");
  const rootReinspection = await inspections();
  assert.equal(rootReinspection.length, 2);
  assert.deepEqual(rootReinspection.map(item => item.args.arguments), [
    { sourcePath }, { sourcePath, manifestSelection: "root" },
  ]);
  assert.deepEqual(rootReinspection[1].args, { name: "inspect_ztools_source_build", arguments: { sourcePath, manifestSelection: "root" }, clientId: "atools-ui", confirmed: false });
  assert.equal(rootReinspection[1].response.id, rootReinspection[1].runId);
  assert.equal(rootReinspection[1].response.capabilityId, "inspect_ztools_source_build");
  assert.deepEqual(rootReinspection[1].response.initiator, { type: "human", clientId: "atools-ui" });
  assert.equal(rootReinspection[1].response.status, "succeeded");
  assert.deepEqual(rootReinspection[1].response.input, { sourcePath, manifestSelection: "root" });
  assert.equal(rootReinspection[1].response.output.manifestSha256, "a".repeat(64));
  assert.equal(rootChoice.afterSpace.choices[0].selected, true);
  assert.deepEqual(rootChoice.afterSpace.convertButtons, [{ disabled: false }]);
  const rootConfirmed = await waitFor(`${sourceRow}?.querySelector('.manifest-choices article.selected .selected-label')?.textContent.includes('已按所选清单重新检查')`);
  assert.ok(rootConfirmed);
  assert.deepEqual((await state()).convertButtons, [{ disabled: false }]);

  await setViewport(420, 760, "dark");
  await evaluate(`${sourceChoices}?.scrollIntoView({block:'start'})`);
  const compactBefore = await state();
  assert.deepEqual(compactBefore.choices.map(choice => [choice.label, choice.path, choice.version]), [
    ["项目根目录", "plugin.json", "1.4.0"], ["发布目录", "public/plugin.json", "0.9.0"],
  ]);
  assert.ok(compactBefore.choices.every(choice => choice.visible), `Compact manifest choices are not fully visible: ${JSON.stringify(compactBefore.choices)}`);
  const compact = await assertNoOverflow("manifest-choice-420x760-dark");
  const compactShot = await screenshot("manifest-choice-stacked-420-dark");
  const publicChoice = await requestWithKeyboard("public", "public-manifest-recheck");
  assert.equal(publicChoice.afterSpace.choices[1].selected, true);
  assert.deepEqual(publicChoice.pending.convertButtons, [], "Changing the selected manifest invalidates the prior inspection while re-inspection is pending");
  assert.deepEqual(publicChoice.afterSpace.convertButtons, [{ disabled: false }], "The public choice becomes available only after its held re-inspection resolves");
  const allInspections = await inspections();
  assert.equal(allInspections.length, 3);
  assert.deepEqual(allInspections.map(item => item.args.arguments), [
    { sourcePath }, { sourcePath, manifestSelection: "root" }, { sourcePath, manifestSelection: "public" },
  ]);
  assert.deepEqual(allInspections[2].args, { name: "inspect_ztools_source_build", arguments: { sourcePath, manifestSelection: "public" }, clientId: "atools-ui", confirmed: false });
  assert.equal(allInspections[2].response.id, allInspections[2].runId);
  assert.equal(allInspections[2].response.capabilityId, "inspect_ztools_source_build");
  assert.deepEqual(allInspections[2].response.initiator, { type: "human", clientId: "atools-ui" });
  assert.equal(allInspections[2].response.status, "succeeded");
  assert.deepEqual(allInspections[2].response.input, { sourcePath, manifestSelection: "public" });
  assert.equal(allInspections[2].response.output.manifestSha256, "b".repeat(64));
  const publicConfirmed = await waitFor(`${sourceRow}?.querySelector('.manifest-choices article.selected .selected-label')?.textContent.includes('已按所选清单重新检查')`);
  assert.ok(publicConfirmed);
  const final = await state();
  assert.equal(final.choices[1].selected, true);
  assert.deepEqual(final.convertButtons, [{ disabled: false }]);
  const scrollportSelector = ".system-panel.import-shell";
  const scrollportState = async label => evaluate(`(()=>{
    const port=document.querySelector(${JSON.stringify(scrollportSelector)}),main=document.querySelector('.shell-content'),frame=document.querySelector('.shell-frame');
    if(!port||!main||!frame)return null;
    const portStyle=getComputedStyle(port),mainStyle=getComputedStyle(main),frameStyle=getComputedStyle(frame);
    return {label:${JSON.stringify(label)},scrollport:{scrollTop:port.scrollTop,scrollHeight:port.scrollHeight,clientHeight:port.clientHeight,overflowY:portStyle.overflowY},shellContent:{scrollTop:main.scrollTop,scrollHeight:main.scrollHeight,clientHeight:main.clientHeight,overflowY:mainStyle.overflowY},shellFrame:{scrollTop:frame.scrollTop,scrollHeight:frame.scrollHeight,clientHeight:frame.clientHeight,overflowY:frameStyle.overflowY}};
  })()`);
  const initialScrollport = await scrollportState("before-wheel");
  assert.ok(initialScrollport, "The import route owns its expected scrollport and shell bounds");
  assert.ok(initialScrollport.scrollport.scrollHeight > initialScrollport.scrollport.clientHeight, `The import scrollport must contain overflow: ${JSON.stringify(initialScrollport)}`);
  assert.ok(["auto", "scroll"].includes(initialScrollport.scrollport.overflowY), `The import route must be the vertical scroll owner: ${JSON.stringify(initialScrollport)}`);
  assert.ok(!["auto", "scroll"].includes(initialScrollport.shellContent.overflowY), `The shell content must not become a second scrollport: ${JSON.stringify(initialScrollport)}`);
  assert.equal(initialScrollport.shellContent.scrollTop, 0, `The App main surface must not be used as the import scrollport: ${JSON.stringify(initialScrollport)}`);
  assert.equal(initialScrollport.shellFrame.scrollTop, 0, `The fixed shell must not be used as the import scrollport: ${JSON.stringify(initialScrollport)}`);
  assert.equal(initialScrollport.shellFrame.overflowY, "hidden", `The app shell retains its clipping boundary: ${JSON.stringify(initialScrollport)}`);
  let wheelEvents = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await scrollportState("return-to-top");
    if (current.scrollport.scrollTop <= 0) break;
    await wheel(scrollportSelector, -480);
    wheelEvents++;
  }
  const atTop = await scrollportState("wheel-top");
  assert.equal(atTop.scrollport.scrollTop, 0, `Real wheel input should return the import scrollport to its start: ${JSON.stringify(atTop)}`);
  const targetVisibility = async () => evaluate(`(()=>{
    const clippedVisibility=${clippedVisibility};
    const selected=${sourceRow}?.querySelector('.manifest-choices article.selected');
    const title=selected?.querySelector('strong'),label=selected?.querySelector('.selected-label');
    const action=Array.from(${sourceRow}?.querySelectorAll('.source-build button') ?? []).find(button=>button.textContent.trim()==='一键转换并安装');
    if(!selected||!title||!label||!action||action.disabled)return null;
    return {title:clippedVisibility(title),label:clippedVisibility(label),action:clippedVisibility(action)};
  })()`);
  let wheelVisibleTargets = await targetVisibility();
  let wheelMovedScrollport = false;
  for (let attempt = 0; attempt < 16 && !(wheelVisibleTargets?.label.fullyVisible && wheelVisibleTargets?.action.fullyVisible); attempt++) {
    const beforeWheel = await scrollportState("before-down-wheel");
    await wheel(scrollportSelector, 120);
    wheelEvents++;
    const afterWheel = await scrollportState("after-down-wheel");
    assert.ok(afterWheel.scrollport.scrollTop > beforeWheel.scrollport.scrollTop, `A real CDP wheel event should move the import scrollport: ${JSON.stringify({ beforeWheel, afterWheel })}`);
    wheelMovedScrollport = true;
    wheelVisibleTargets = await targetVisibility();
  }
  assert.ok(wheelEvents > 0 && wheelMovedScrollport, "The import route was scrolled through CDP mouse-wheel input");
  assert.ok(wheelVisibleTargets?.label.fullyVisible && wheelVisibleTargets?.action.fullyVisible, `Real wheel input must bring the selected label and enabled conversion action inside the clipping bounds: ${JSON.stringify({ wheelVisibleTargets, scrollport: await scrollportState("wheel-targets") })}`);
  const scrolledTargets = await evaluate(`(()=>{
    const clippedVisibility=${clippedVisibility};
    const selected=${sourceRow}?.querySelector('.manifest-choices article.selected');
    const title=selected?.querySelector('strong');
    const label=selected?.querySelector('.selected-label');
    const action=Array.from(${sourceRow}?.querySelectorAll('.source-build button') ?? []).find(button=>button.textContent.trim()==='一键转换并安装');
    if(!selected||!title||!label||!action||action.disabled)return null;
    return {title:clippedVisibility(title),label:clippedVisibility(label),action:clippedVisibility(action)};
  })()`);
  assert.ok(scrolledTargets, 'The selected public manifest card, label, and enabled conversion action exist before the final screenshot');
  assert.equal(scrolledTargets.title.fullyVisible, true, `Selected public manifest title remains clipped after scrolling: ${JSON.stringify(scrolledTargets)}`);
  assert.equal(scrolledTargets.label.fullyVisible, true, `Selected public manifest label remains clipped after scrolling: ${JSON.stringify(scrolledTargets)}`);
  assert.equal(scrolledTargets.action.fullyVisible, true, `Conversion action remains clipped after scrolling: ${JSON.stringify(scrolledTargets)}`);
  const finalScrollport = await scrollportState("after-wheel");
  assert.ok(finalScrollport.scrollport.scrollTop > 0, `Wheel input reached lower import content: ${JSON.stringify(finalScrollport)}`);
  assert.equal(finalScrollport.shellContent.scrollTop, 0, `The main shell must remain outside import scrolling: ${JSON.stringify(finalScrollport)}`);
  assert.equal(finalScrollport.shellFrame.scrollTop, 0, `The fixed shell must remain outside import scrolling: ${JSON.stringify(finalScrollport)}`);
  const finalScrolled = await state();
  assert.equal(await fixture("calls.filter(call=>call.command==='start_agent_tool').length"), 3);
  assert.equal(await fixture("calls.filter(call=>call.command==='convert_ztools_plugin').length"), 0);
  const finalShot = await screenshot("manifest-choice-rechecked-public-420-dark");
  return {
    scope: "Real source-build choice UI with a synthetic local inspect TaskRun only; no source conversion, installation, or permission flow is invoked. Initial wide and stacked screenshots assert both cards are fully inside ancestor clips; final label and conversion-action visibility follows real CDP wheel input within the import panel.",
    provisionalCandidate: { version: "1.0.0", checkboxDisabled: beforeInspection.checkboxDisabled, convertAvailable: beforeInspection.convertButtons.length > 0 },
    initial, rootChoice, rootConfirmed, compactBefore, compactChoice: publicChoice, publicConfirmed, final,
    finalScrolled, scrolledTargets, initialScrollport, atTop, finalScrollport, wheelVisibleTargets, wheelEvents,
    visibilityContract: "Choice and naturally Tab-focused button visibility means full containment within the viewport intersected with every overflow-clipping ancestor. CDP mouse-wheel input moves the import-owned scrollport until the selected label and enabled conversion action are fully visible; the shell itself does not scroll.",
    inspectionInputs: allInspections.map(item => item.args.arguments), wide, compact,
    screenshots: [precheckShot, wideShot, compactShot, finalShot], conversionCalls: 0,
  };
}
