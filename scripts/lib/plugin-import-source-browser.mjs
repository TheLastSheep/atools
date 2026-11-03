import assert from "node:assert/strict";

/** Browser-only evidence for the actual import panel, with synthetic IPC candidate records. */
export async function verifyImportSourceChoices({ evaluate, waitFor, fixture, key, click, clickButton, setViewport, screenshot, assertNoOverflow, assertReportState, importCalls }) {
  const sourcePath = "/fixture/source-choice/calculator";
  const zpxPath = `${sourcePath}/published-calculator-0.9.0.zpx`;
  const zipPath = `${sourcePath}/another-published-calculator-2.0.0.zip`;
  const checkbox = path => `input[id=${JSON.stringify(`ztools-import-${encodeURIComponent(path)}`)}]`;
  const selectedState = () => evaluate(`(()=>({rows:Array.from(document.querySelectorAll('.candidate-row')).map(row=>({path:row.querySelector('.candidate-path')?.textContent,checked:row.querySelector('input')?.checked,disabled:row.querySelector('input')?.disabled})),importButton:Array.from(document.querySelectorAll('.import-panel button')).filter(button=>button.textContent.trim().startsWith('导入 ')).map(button=>({text:button.textContent.trim(),disabled:button.disabled}))}))()`);
  const screenshots = [];
  const keyboardFocus = [];
  const keyboardSelections = [];
  const rememberKeyboardSelection = async action => keyboardSelections.push({ action, activeId: await evaluate("document.activeElement?.id||null"), state: await selectedState() });
  const tabTo = async selector => {
    for (let step = 0; step < 24; step++) {
      const reached = await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
      if (reached) return;
      await key("Tab", "Tab", 9);
      keyboardFocus.push(await evaluate("({tag:document.activeElement?.tagName,id:document.activeElement?.id||null,label:document.activeElement?.getAttribute('aria-label')||null})"));
    }
    assert.fail(`Natural Tab navigation did not reach ${selector}`);
  };

  await setViewport(900, 760, "light");
  await fixture("planScan('scan_default_ztools_plugins','source-choice-scan')");
  await clickButton("扫描 ZTools");
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.pendingKey==='source-choice-scan')");
  await fixture("resolveScan('source-choice-scan',window.pluginImportTransactionFixture.sourceChoiceCandidates)");
  await waitFor("document.querySelectorAll('.candidate-row').length===3 && !document.querySelector('.busy-line')");
  const initial = await selectedState();
  assert.deepEqual(initial.rows.map(row => row.checked), [false, false, false]);
  assert.deepEqual(initial.rows.map(row => row.disabled), [true, false, false]);
  assert.deepEqual(initial.importButton, [{ text: "导入 0 个插件", disabled: true }]);
  const initialLayout = await assertNoOverflow("source-choice-default-900x760-light");
  screenshots.push(await screenshot("source-choice-default-900-light"));

  // The search field is the starting point; checkbox focus is obtained only through browser Tab navigation.
  await click("[data-atools-search-input]");
  await tabTo(checkbox(zpxPath));
  await key(" ", "Space", 32);
  assert.deepEqual((await selectedState()).rows.map(row => row.checked), [false, true, false]);
  await rememberKeyboardSelection("Tab to ZPX then Space");
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(checkbox(zipPath))})`), true);
  await key(" ", "Space", 32);
  assert.deepEqual((await selectedState()).rows.map(row => row.checked), [false, false, true]);
  await rememberKeyboardSelection("Tab to ZIP then Space replaces ZPX");
  await key("Tab", "Tab", 9, 8);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(checkbox(zpxPath))})`), true);
  await key(" ", "Space", 32);
  assert.deepEqual((await selectedState()).rows.map(row => row.checked), [false, true, false]);
  await rememberKeyboardSelection("Shift+Tab to ZPX then Space replaces ZIP");
  const keyboardCheckboxBounds = await evaluate("(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth}})()");
  assert.ok(keyboardCheckboxBounds.width <= 32 && keyboardCheckboxBounds.height <= 32, `Checkbox focus must not stretch over its metadata row: ${JSON.stringify(keyboardCheckboxBounds)}`);
  assert.notEqual(keyboardCheckboxBounds.outlineStyle, "none");
  screenshots.push(await screenshot("source-choice-keyboard-focused-zpx-900-light"));
  await clickButton("选择无冲突来源");
  const explicitChoice = await selectedState();
  assert.deepEqual(explicitChoice.rows.map(row => row.checked), [false, true, false]);
  const selectedLayout = await assertNoOverflow("source-choice-selected-900x760-light");
  screenshots.push(await screenshot("source-choice-selected-zpx-900-light"));

  const beforeImport = (await importCalls()).length;
  const error = "静态验收示例：安装包暂时无法写入。请检查目标目录后重试，已选来源会保留。";
  await fixture(`queueImport({imported:[],skipped:[],failed:[{path:${JSON.stringify(zpxPath)},error:${JSON.stringify(error)}}]})`);
  await clickButton("导入 1 个插件");
  await waitFor("document.querySelector('.report-row.failed')");
  const calls = await importCalls();
  assert.equal(calls.length, beforeImport + 1);
  assert.deepEqual(calls.at(-1).args, { paths: [zpxPath], overwrite: true });
  assert.deepEqual((await selectedState()).rows.map(row => row.checked), [false, true, false]);
  const wideError = await assertReportState("source-choice-error-900x760-light", "重试失败 1 个", ".report-row.failed .result-copy strong");
  assert.equal(wideError.reportStatus, error);
  screenshots.push(await screenshot("source-choice-import-error-900-light"));
  await setViewport(420, 760, "dark");
  await evaluate("document.querySelector('.candidate-list')?.scrollIntoView({block:'start'})");
  const compactChoice = await assertNoOverflow("source-choice-selected-420x760-dark");
  screenshots.push(await screenshot("source-choice-selected-zpx-420-dark"));
  const compactError = await assertReportState("source-choice-error-420x760-dark", "重试失败 1 个", ".report-row.failed .result-copy strong");
  assert.equal(compactError.reportStatus, error);
  const errorText = await evaluate("(()=>{const e=document.querySelector('.report-row.failed .result-copy strong'),r=e.getBoundingClientRect();return {scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,textOverflow:getComputedStyle(e).textOverflow,whiteSpace:getComputedStyle(e).whiteSpace,bounds:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}}})()");
  const errorPath = await evaluate("(()=>{const e=document.querySelector('.report-row.failed .result-copy small');return {text:e.textContent,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,whiteSpace:getComputedStyle(e).whiteSpace}})()");
  screenshots.push(await screenshot("source-choice-import-error-420-dark"));
  assert.ok(errorText.scrollWidth <= errorText.clientWidth, `Compact import error text is clipped: ${JSON.stringify(errorText)}`);
  assert.ok(errorPath.scrollWidth <= errorPath.clientWidth, `Compact source path is clipped: ${JSON.stringify(errorPath)}`);
  assert.equal(errorPath.text, zpxPath);
  return { initial, explicitChoice, submittedImport: calls.at(-1), initialLayout, selectedLayout, wideError, compactChoice, compactError, errorText, errorPath, keyboardFocus, keyboardSelections, keyboardCheckboxBounds, screenshots,
    scope: "Static Chromium DOM/CDP fixture only; Space and Tab are browser keyboard events, not native physical input. Candidate identity and import failure are synthetic IPC values; no package is opened or installed." };
}
