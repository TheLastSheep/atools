import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const INPUT = 'input[data-atools-search-input="true"]';
const HOME = ".home-panel";

export function createHomeExpansionScenarios({ page, outputDir, runId, delay }) {
  const checks = [];
  const screenshots = [];
  const fixtureResets = [];
  let lastResetPointer = null;

  async function cdp(method, params = {}, timeoutMs = 12000) {
    return page.send(method, params, { timeoutMs });
  }

  async function evaluate(expression, timeoutMs = 12000) {
    const response = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    assert.ok(!response.exceptionDetails,
      response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || "Browser expression failed");
    return response.result.value;
  }

  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(35);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  }

  async function key(keyValue, code = keyValue, virtualKey = 0, modifiers = 0) {
    const params = { key: keyValue, code, windowsVirtualKeyCode: virtualKey, modifiers };
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown", ...params,
      ...(keyValue === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await delay(70);
  }

  async function click(selector) {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}})()`);
    assert.ok(point?.visible, `Expected visible click target ${selector}: ${JSON.stringify(point)}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
    await delay(90);
  }

  async function clickSectionToggle(section) {
    const measure = `(()=>{
      const buttons=Array.from(document.querySelectorAll('${HOME} button[aria-controls][aria-expanded]'));
      const button=buttons.find(candidate=>{
        const name=[candidate.getAttribute('aria-label'),candidate.title,candidate.textContent].filter(Boolean).join(' ');
        return ${section === "pinned" ? "/固定/" : "/最近使用/"}.test(name);
      });
      if(!button)return {found:false,buttons:buttons.map(b=>({name:[b.getAttribute('aria-label'),b.title,b.textContent].filter(Boolean).join(' ').trim(),expanded:b.getAttribute('aria-expanded'),controls:b.getAttribute('aria-controls')}))};
      const region=button.closest('.home-command-scroll'),r=button.getBoundingClientRect(),s=region?.getBoundingClientRect();
      if(!region||!s)return {found:true,regionFound:false};
      const bounds={left:s.left+region.clientLeft,right:s.left+region.clientLeft+region.clientWidth,top:s.top+region.clientTop,bottom:s.top+region.clientTop+region.clientHeight};
      const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
      const clipLeft=Math.max(0,bounds.left),clipRight=Math.min(innerWidth,bounds.right),clipTop=Math.max(0,bounds.top),clipBottom=Math.min(innerHeight,bounds.bottom);
      const wheelX=(clipLeft+clipRight)/2,wheelY=(clipTop+clipBottom)/2;
      const deltaY=r.bottom>bounds.bottom?Math.max(80,Math.ceil(r.bottom-bounds.bottom+32)):r.top<bounds.top?-Math.max(80,Math.ceil(bounds.top-r.top+32)):0;
      const viewportVisible=r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;
      const visibleWithinScroll=r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;
      const hitTarget=Boolean(hit&&(hit===button||button.contains(hit)));
      const wheelPointInside=clipRight>clipLeft&&clipBottom>clipTop&&wheelX>=bounds.left&&wheelX<=bounds.right&&wheelY>=bounds.top&&wheelY<=bounds.bottom;
      return {found:true,regionFound:true,x,y,viewportVisible,visibleWithinScroll,hitTarget,wheelX,wheelY,wheelPointInside,deltaY,buttonRect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},scrollRect:{top:s.top,bottom:s.bottom,left:s.left,right:s.right},name:[button.getAttribute('aria-label'),button.title,button.textContent].filter(Boolean).join(' ').trim(),expanded:button.getAttribute('aria-expanded'),controls:button.getAttribute('aria-controls')};
    })()`;
    const wheelAttempts = [];
    let point;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      point = await evaluate(measure);
      assert.ok(point?.found, `Missing ${section} section expansion button: ${JSON.stringify(point)}`);
      assert.ok(point.regionFound, `${section} toggle is not inside the home scrollport: ${JSON.stringify(point)}`);
      if (point.viewportVisible && point.visibleWithinScroll && point.hitTarget) break;
      assert.ok(point.wheelPointInside && point.deltaY !== 0,
        `${section} toggle is clipped or covered and cannot be reached by scrollport wheel: ${JSON.stringify(point)}`);
      wheelAttempts.push({ x: point.wheelX, y: point.wheelY, deltaY: point.deltaY });
      await cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: point.wheelX, y: point.wheelY, deltaX: 0, deltaY: point.deltaY,
      });
      await delay(90);
    }
    assert.ok(point?.viewportVisible && point.visibleWithinScroll && point.hitTarget,
      `${section} section toggle is not fully visible and hit-testable inside the home scrollport: ${JSON.stringify({ point, wheelAttempts })}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
    await delay(90);
    return { ...point, wheelAttempts };
  }

  async function toggleState(section) {
    return evaluate(`(()=>{
      const buttons=Array.from(document.querySelectorAll('${HOME} button[aria-controls][aria-expanded]'));
      const button=buttons.find(candidate=>{
        const name=[candidate.getAttribute('aria-label'),candidate.title,candidate.textContent].filter(Boolean).join(' ');
        return ${section === "pinned" ? "/固定/" : "/最近使用/"}.test(name);
      });
      if(!button)return null;
      const controlled=document.getElementById(button.getAttribute('aria-controls')||'');
      const region=button.closest('.home-command-scroll');
      const r=button.getBoundingClientRect(),s=region?.getBoundingClientRect();
      const bounds=s&&region?{left:s.left+region.clientLeft,right:s.left+region.clientLeft+region.clientWidth,top:s.top+region.clientTop,bottom:s.top+region.clientTop+region.clientHeight}:null;
      const insideScroll=rect=>Boolean(rect&&bounds&&rect.left>=bounds.left-1&&rect.right<=bounds.right+1&&rect.top>=bounds.top-1&&rect.bottom<=bounds.bottom+1);
      const visibleWithinScroll=insideScroll(r),rows=Array.from(controlled?.querySelectorAll(':scope > .recent-item-shell')||[]),first=rows[0]?.getBoundingClientRect();
      const firstRows=first?rows.map(item=>item.getBoundingClientRect()).filter(item=>Math.abs(item.top-first.top)<1):[];
      const firstRowRect=first?{left:Math.min(...firstRows.map(item=>item.left)),right:Math.max(...firstRows.map(item=>item.right)),top:Math.min(...firstRows.map(item=>item.top)),bottom:Math.max(...firstRows.map(item=>item.bottom))}:null;
      const firstRowVisibleWithinScroll=insideScroll(firstRowRect),focused=document.activeElement===button;
      return {name:[button.getAttribute('aria-label'),button.title,button.textContent].filter(Boolean).join(' ').trim(),expanded:button.getAttribute('aria-expanded'),controls:button.getAttribute('aria-controls'),controlledGrid:Boolean(controlled?.matches('.recent-grid')),controlledSection:controlled?.getAttribute('aria-label')||null,focused,visibleWithinScroll,firstRowRect,firstRowVisibleWithinScroll,focusedHeaderAndFirstRowVisibleWithinScroll:focused&&visibleWithinScroll&&firstRowVisibleWithinScroll};
    })()`);
  }

  function stateExpression() {
    return `(()=>{
      const panel=document.querySelector('${HOME}');
      const grids=Array.from(panel?.querySelectorAll('.recent-grid')||[]);
      const section=grid=>({kind:grid.classList.contains('pinned-grid')?'pinned':'recent',label:grid.getAttribute('aria-label'),count:grid.querySelectorAll(':scope > .recent-item-shell').length,labels:Array.from(grid.querySelectorAll(':scope > .recent-item-shell .recent-label')).map(el=>el.textContent.trim()),columns:getComputedStyle(grid).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length,scrollWidth:grid.scrollWidth,clientWidth:grid.clientWidth});
      const selected=panel?.querySelector('.recent-item-shell.selected');
      const selectedLabel=selected?.querySelector('.recent-label')?.textContent.trim()||null;
      const input=document.querySelector('${INPUT}');
      const region=panel?.querySelector('.home-command-scroll');
      const shell=document.querySelector('.shell-frame');
      const active=document.activeElement;
      const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,top:r.top,left:r.left,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const homeMarkup=panel?.outerHTML||'';
      const semanticElements=Array.from(document.querySelectorAll('.shell-frame button,.shell-frame input,.shell-frame [role="status"],.shell-frame [role="listbox"],.shell-frame [role="option"]')).slice(0,160).map(element=>({tag:element.tagName,role:element.getAttribute('role'),label:element.getAttribute('aria-label'),text:(element.textContent||'').trim().slice(0,120),className:typeof element.className==='string'?element.className:'',selected:element.getAttribute('aria-selected'),expanded:element.getAttribute('aria-expanded'),controls:element.getAttribute('aria-controls'),index:element.getAttribute('data-home-command-index')||element.getAttribute('data-result-index'),value:'value'in element?element.value:null,selectionStart:'selectionStart'in element?element.selectionStart:null,selectionEnd:'selectionEnd'in element?element.selectionEnd:null,disabled:Boolean(element.disabled),tabIndex:element.tabIndex,rect:rect(element)}));
      const status=document.querySelector('.search-status-bar');
      const statusTitle=status?.querySelector('.status-title')?.textContent.trim()||null;
      const statusDetail=status?.querySelector('.status-detail')?.textContent.trim()||null;
      const overflow=[['document',document.documentElement],['body',document.body],['shell',shell],['home-panel',panel],['home-scroll',region],...grids.map((grid,index)=>['grid-'+index,grid])]
        .filter(([,element])=>element&&element.scrollWidth>element.clientWidth+1).map(([name])=>name);
      const scrollRect=rect(region),selectedRect=rect(selected);
      const selectedVisibleInScroll=Boolean(selectedRect&&scrollRect&&selectedRect.top>=scrollRect.top+(region?.clientTop||0)-1&&selectedRect.bottom<=scrollRect.top+(region?.clientTop||0)+(region?.clientHeight||0)+1);
      return {viewport:{width:innerWidth,height:innerHeight},appearance:{prefersDark:matchMedia('(prefers-color-scheme: dark)').matches,background:getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()},sections:grids.map(section),total:panel?.querySelectorAll('.recent-item-shell').length||0,
        selected:{index:Number(selected?.dataset.homeCommandIndex??-1),label:selectedLabel,visible:Boolean(selected&&selected.getBoundingClientRect().bottom>0&&selected.getBoundingClientRect().top<innerHeight),visibleInHomeScroll:selectedVisibleInScroll},
        input:{present:Boolean(input),focused:document.activeElement===input,value:input?.value||'',selectionStart:input?.selectionStart??null,selectionEnd:input?.selectionEnd??null,activeDescendant:input?.getAttribute('aria-activedescendant')||null},
        dom:{activeElement:active?{tag:active.tagName,role:active.getAttribute('role'),label:active.getAttribute('aria-label'),className:typeof active.className==='string'?active.className:'',text:(active.textContent||'').trim().slice(0,160)}:null,shellText:document.querySelector('.shell-frame')?.innerText?.slice(0,12000)||'',homeMarkup:homeMarkup.slice(0,32000),homeMarkupLength:homeMarkup.length,homeMarkupTruncated:homeMarkup.length>32000,semanticElements},
        status:{title:statusTitle,detail:statusDetail},scroll:{home:region?.scrollTop||0,document:document.scrollingElement?.scrollTop||0},shell:rect(shell),panel:rect(panel),scrollRect,selectedRect,overflow,
        toggles:Array.from(panel?.querySelectorAll('button[aria-controls][aria-expanded]')||[]).map(button=>({name:[button.getAttribute('aria-label'),button.title,button.textContent].filter(Boolean).join(' ').trim(),expanded:button.getAttribute('aria-expanded'),controls:button.getAttribute('aria-controls')}))};
    })()`;
  }

  async function state(timeoutMs = 12000) {
    return evaluate(stateExpression(), timeoutMs);
  }

  async function captureDiagnostics(timeoutMs = 2500) {
    const expression = `(()=>({state:(${stateExpression()}),fixtureSnapshot:window.homeExpansionFixture?.snapshot?.()??null}))()`;
    return evaluate(expression, timeoutMs);
  }

  async function screenshot(name) {
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = join(outputDir, `${name}-${runId}.png`);
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(file, bytes);
    const evidence = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), viewport: (await state()).viewport };
    screenshots.push(evidence);
    return evidence;
  }

  async function setViewport(width, theme) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 600, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await waitFor(`innerWidth===${width}&&innerHeight===600`);
    await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,1000))])");
    await delay(120);
  }

  async function resetFixture() {
    const neutral = await evaluate(`(()=>{const shell=document.querySelector('.shell-frame')?.getBoundingClientRect();const point={x:innerWidth-2,y:innerHeight-2};return {...point,outsideApp:!shell||point.x<shell.left||point.x>shell.right||point.y<shell.top||point.y>shell.bottom}})()`);
    assert.equal(neutral.outsideApp, true, `Reset pointer target must be outside the App shell: ${JSON.stringify(neutral)}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: neutral.x, y: neutral.y });
    lastResetPointer = { ...neutral, movedBy: "CDP Input.dispatchMouseEvent mouseMoved" };
    await delay(60);
    assert.equal(await evaluate("window.homeExpansionFixture.resetFixture()"), true, "Fixture reset should remount the real App");
    await waitFor("window.homeExpansionFixture && document.querySelector('.home-panel') && document.querySelector('[data-atools-search-input]')");
    await waitFor("document.querySelectorAll('.home-panel .recent-grid .recent-item-shell').length===18");
    const seeded = await state();
    assert.equal(seeded.selected.index, 0, `Fixture reset must restore the first seeded pin selection: ${JSON.stringify(seeded.selected)}`);
    assert.equal(seeded.selected.label, await evaluate("window.homeExpansionFixture.pinLabels[0]"), "Fixture reset should restore the first fixed command identity");
    assert.deepEqual(Object.fromEntries(seeded.sections.map(section => [section.kind, section.count])), { pinned: 9, recent: 9 },
      "Fixture reset should restore the collapsed 9/9 seed state");
    fixtureResets.push({ pointer: structuredClone(neutral), selected: seeded.selected, sections: seeded.sections.map(section => ({ kind: section.kind, count: section.count })) });
  }

  async function assertCounts(pinned, recent, label) {
    const current = await state();
    const counts = Object.fromEntries(current.sections.map(section => [section.kind, section.count]));
    assert.deepEqual(counts, { pinned, recent }, `${label}: expected exact fixed/recent candidate counts`);
    assert.equal(current.total, pinned + recent, `${label}: section count total mismatch`);
    assert.deepEqual(current.overflow, [], `${label}: horizontal overflow is not allowed`);
    for (const [section, count] of [["pinned", pinned], ["recent", recent]]) {
      const toggle = await toggleState(section);
      assert.ok(toggle?.controlledGrid, `${label}: ${section} ARIA control must point to its real grid`);
      assert.equal(toggle.controlledSection, section === "pinned" ? "固定指令" : "最近使用", `${label}: ${section} control target mismatch`);
      assert.equal(toggle.expanded, count > 9 ? "true" : "false", `${label}: ${section} aria-expanded must match its rendered count`);
    }
    return current;
  }

  async function assertExactLabels(section, expected, label) {
    const current = await state();
    const observed = current.sections.find(item => item.kind === section)?.labels;
    assert.deepEqual(observed, expected, `${label}: rendered candidates differ from the fixed fixture list`);
    return current;
  }

  async function tabToToggle(section) {
    await click(INPUT);
    const activeBefore = await evaluate("document.activeElement===document.querySelector('input[data-atools-search-input=true]')");
    assert.equal(activeBefore, true, "Search input should be the real keyboard navigation starting point");
    const normalized = await keyToHomeIndex(0);
    assert.equal(normalized.selected.index, 0, "Arrow navigation should normalize the selected Home command to the first fixed item before Tab");
    assert.equal(normalized.selected.label, await evaluate("window.homeExpansionFixture.pinLabels[0]"));
    assert.equal(normalized.selected.visibleInHomeScroll, true, "The selected pin must be visible before testing Tab traversal");
    const trace = [];
    for (let index = 0; index < 20; index += 1) {
      await key("Tab", "Tab", 9);
      const focus = await evaluate(`(()=>{const e=document.activeElement;const row=e?.closest('[data-home-command-index]');return {tag:e?.tagName||null,role:e?.getAttribute('role')||null,label:e?.getAttribute('aria-label')||null,title:e?.title||null,text:(e?.textContent||'').trim().slice(0,72),className:typeof e?.className==='string'?e.className:'',homeIndex:row?.getAttribute('data-home-command-index')||null,selectedHomeRow:Boolean(row?.classList.contains('selected')),expanded:e?.getAttribute('aria-expanded'),controls:e?.getAttribute('aria-controls'),hasFocus:document.hasFocus()}})()`);
      trace.push(focus);
      if (index === 0) {
        assert.equal(focus.homeIndex, "0", `Tab from search should enter the selected first pinned command: ${JSON.stringify(focus)}`);
        assert.equal(focus.selectedHomeRow, true, `First Tab destination must agree with selected Home identity: ${JSON.stringify(focus)}`);
      }
      const name = `${focus.label || ""} ${focus.title || ""} ${focus.text || ""}`;
      const sectionMatches = section === "pinned" ? /固定/.test(name) : /最近使用/.test(name);
      if (focus.tag === "BUTTON" && focus.controls && focus.expanded !== null && sectionMatches) {
        await key("Enter", "Enter", 13);
        await waitFor(`document.querySelector('${HOME} button[aria-controls="${focus.controls}"]')?.getAttribute('aria-expanded')==='true'`);
        return { trace, focus, toggle: await toggleState(section), initialSelection: normalized.beforeNavigation.selected, selectionNormalizationPath: normalized.path };
      }
    }
    assert.fail(`Tab did not reach the ${section} expansion button: ${JSON.stringify(trace)}`);
  }

  async function focusSearchAndSelectRecentSecond() {
    await click(INPUT);
    await keyToHomeIndex(10); // fixed fixture index: 9 collapsed pins + second recent item
    const selected = await state();
    assert.equal(selected.selected.index, 10, "Arrow navigation should select the second recent command");
    assert.equal(selected.selected.visibleInHomeScroll, true, "Returning to search and navigating should bring the selected command into view");
    assert.equal(selected.selected.label, await evaluate("window.homeExpansionFixture.recentLabels[1]"));
    return selected;
  }

  async function keyToHomeIndex(targetIndex) {
    const current = await state();
    const beforeNavigation = structuredClone(current);
    const columns = current.sections.find(section => section.kind === "recent").columns;
    assert.ok(Number.isSafeInteger(columns) && columns > 0, "Expanded recent grid must expose real CSS columns");
    const rows = [];
    let offset = 0;
    for (const section of current.sections) {
      for (let start = 0; start < section.count; start += columns) {
        rows.push(Array.from({ length: Math.min(columns, section.count - start) }, (_, index) => offset + start + index));
      }
      offset += section.count;
    }
    const indexToRow = new Map(rows.flatMap((row, rowIndex) => row.map(index => [index, rowIndex])));
    const startIndex = current.selected.index;
    const queue = [startIndex];
    const previous = new Map([[startIndex, null]]);
    for (let position = 0; position < queue.length && !previous.has(targetIndex); position += 1) {
      const index = queue[position];
      const rowIndex = indexToRow.get(index);
      const row = rows[rowIndex];
      const column = row.indexOf(index);
      const above = rows[rowIndex - 1];
      const below = rows[rowIndex + 1];
      const adjacent = [row[column - 1], row[column + 1],
        above?.[Math.min(column, above.length - 1)], below?.[Math.min(column, below.length - 1)]]
        .filter(Number.isInteger);
      for (const next of adjacent) {
        if (previous.has(next)) continue;
        previous.set(next, index);
        queue.push(next);
      }
    }
    assert.ok(previous.has(targetIndex), `Rendered keyboard rows have no route to fixed expected index ${targetIndex}`);
    const path = [];
    for (let index = targetIndex; index !== startIndex; index = previous.get(index)) path.push(index);
    path.reverse();
    let cursor = startIndex;
    for (const next of path) {
      const fromRow = indexToRow.get(cursor), toRow = indexToRow.get(next);
      const fromColumn = rows[fromRow].indexOf(cursor), toColumn = rows[toRow].indexOf(next);
      if (fromRow === toRow && toColumn < fromColumn) await key("ArrowLeft", "ArrowLeft", 37);
      else if (fromRow === toRow && toColumn > fromColumn) await key("ArrowRight", "ArrowRight", 39);
      else if (toRow < fromRow) await key("ArrowUp", "ArrowUp", 38);
      else await key("ArrowDown", "ArrowDown", 40);
      cursor = next;
      await waitFor(`Number(document.querySelector('.recent-item-shell.selected')?.dataset.homeCommandIndex)===${cursor}`, 3000);
    }
    const selectedState = await state();
    assert.equal(selectedState.selected.index, targetIndex, `Keyboard path should land on fixed expected index ${targetIndex}`);
    return { ...selectedState, beforeNavigation, path };
  }

  async function selectLastExpandedRecent() {
    await click(INPUT);
    // Fixed fixture contract: 12 expanded pins followed by 24 recent records, last index 35.
    const selectedState = await keyToHomeIndex(12 + 24 - 1);
    assert.equal(selectedState.selected.label, await evaluate("window.homeExpansionFixture.recentLabels[23]"),
      "Keyboard navigation should reach the last expanded recent command");
    assert.equal(selectedState.selected.visibleInHomeScroll, true, "Keyboard navigation should scroll the expanded selection into view");
    return selectedState;
  }

  async function scrollHomeToTop() {
    const point = await evaluate(`(()=>{const e=document.querySelector('.home-command-scroll');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,scrollTop:e.scrollTop}})()`);
    assert.ok(point, "Home command scrollport should exist");
    if (point.scrollTop > 0) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -1600 });
      await waitFor("document.querySelector('.home-command-scroll')?.scrollTop===0", 3000);
    }
  }

  async function readInputSelection() {
    return evaluate(`(()=>{const input=document.querySelector('${INPUT}');return {start:input?.selectionStart??null,end:input?.selectionEnd??null,value:input?.value||''}})()`);
  }

  async function selectAllRealInputText() {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 0 });
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 0 });
    await delay(35);
    const selection = await readInputSelection();
    assert.equal(selection.start, 0, `Meta+A should select from the start of the real input: ${JSON.stringify(selection)}`);
    assert.equal(selection.end, selection.value.length, `Meta+A should select all real input text: ${JSON.stringify(selection)}`);
    assert.ok(selection.end > selection.start, `Meta+A must leave a non-empty selection before the tested key: ${JSON.stringify(selection)}`);
    return selection;
  }

  async function runLayoutCase(width, theme) {
    await setViewport(width, theme);
    await resetFixture();
    const initial = await assertCounts(9, 9, `collapsed ${width}/${theme}`);
    assert.equal(initial.appearance.prefersDark, theme === "dark", "Emulated color scheme must match the screenshot label");
    assert.ok(initial.appearance.background, "Theme background token must be observable");
    assert.match(initial.appearance.background, theme === "dark" ? /24, 27, 32/ : /246, 247, 249/,
      `Rendered theme token should reflect ${theme}: ${JSON.stringify(initial.appearance)}`);
    await assertExactLabels("pinned", await evaluate("window.homeExpansionFixture.pinLabels.slice(0,9)"), "collapsed pinned first nine");
    await assertExactLabels("recent", await evaluate("window.homeExpansionFixture.recentLabels.slice(0,9)"), "collapsed recent first nine");
    const collapsedShot = await screenshot(`home-collapsed-${width}-${theme}`);
    checks.push({ kind: "collapsed-counts", width, theme, pinned: 9, recent: 9, shell: initial.shell, scroll: initial.scroll });

    const pinToggle = await clickSectionToggle("pinned");
    await waitFor("document.querySelector('.home-panel .pinned-grid')?.querySelectorAll(':scope > .recent-item-shell').length===12");
    const pinnedExpanded = await assertCounts(12, 9, `pinned expanded ${width}/${theme}`);
    assert.equal(pinToggle.expanded, "false", "Pinned toggle should start collapsed");
    assert.equal((await toggleState("pinned")).expanded, "true");
    const pinnedFocus = await toggleState("pinned");
    assert.equal(pinnedFocus.focused, true, "Click expansion must keep focus on its header control");
    assert.equal(pinnedFocus.visibleWithinScroll, true, "Click expansion must keep its focused header inside the scrollport");
    await assertExactLabels("pinned", await evaluate("window.homeExpansionFixture.pinLabels"), "all pinned candidates");
    const pinnedShot = await screenshot(`home-pinned-expanded-${width}-${theme}`);
    await clickSectionToggle("pinned");
    await waitFor("document.querySelector('.home-panel .pinned-grid')?.querySelectorAll(':scope > .recent-item-shell').length===9");
    await assertCounts(9, 9, `pinned collapsed ${width}/${theme}`);

    const tabResult = await tabToToggle("recent");
    await waitFor("document.querySelector('.home-panel .recent-grid:not(.pinned-grid)')?.querySelectorAll(':scope > .recent-item-shell').length===24");
    const recentExpanded = await assertCounts(9, 24, `recent expanded ${width}/${theme}`);
    assert.equal(tabResult.toggle.expanded, "true", "Enter from a real Tab stop should expand recent items");
    assert.equal(tabResult.toggle.focused, true, "Enter expansion must keep focus on the header control");
    assert.equal(tabResult.toggle.visibleWithinScroll, true, "Keyboard expansion must keep its focused header inside the scrollport");
    assert.equal(tabResult.toggle.firstRowVisibleWithinScroll, true, `The first visual recent row must be fully visible with the focused header: ${JSON.stringify(tabResult.toggle)}`);
    assert.equal(tabResult.toggle.focusedHeaderAndFirstRowVisibleWithinScroll, true, `The focused recent header and first visual row must be visible in the same scrollport snapshot: ${JSON.stringify(tabResult.toggle)}`);
    await assertExactLabels("recent", await evaluate("window.homeExpansionFixture.recentLabels"), "all recent candidates");
    const recentShot = await screenshot(`home-recent-expanded-${width}-${theme}`);

    const secondRecent = await focusSearchAndSelectRecentSecond();
    assert.equal(secondRecent.selected.label, await evaluate("window.homeExpansionFixture.recentLabels[1]"));
    await scrollHomeToTop();
    await clickSectionToggle("pinned");
    await waitFor("document.querySelector('.home-panel .pinned-grid')?.querySelectorAll(':scope > .recent-item-shell').length===12");
    const preserved = await state();
    assert.equal(preserved.selected.label, secondRecent.selected.label, "Pinned expansion must preserve the selected recent item identity");
    assert.equal(preserved.selected.index, secondRecent.selected.index + 3, "Selected recent index should follow the added three pinned candidates");
    await assertCounts(12, 24, `both expanded ${width}/${theme}`);
    const bothShot = await screenshot(`home-both-expanded-${width}-${theme}`);

    const scrolledBefore = await selectLastExpandedRecent();
    assert.ok(scrolledBefore.scroll.home > scrolledBefore.beforeNavigation.scroll.home,
      `Selecting the last expanded recent should scroll the inner home region: ${JSON.stringify(scrolledBefore)}`);
    assert.deepEqual(scrolledBefore.shell, scrolledBefore.beforeNavigation.shell,
      "Keyboard scrolling should leave the outer shell geometry unchanged");
    assert.equal(scrolledBefore.scroll.document, scrolledBefore.beforeNavigation.scroll.document,
      "Keyboard scrolling should leave the document scroll position unchanged");
    const scrolledAfter = await state();
    assert.deepEqual(scrolledAfter.shell, scrolledBefore.beforeNavigation.shell, "Inner grid navigation must not move the outer shell");
    assert.equal(scrolledAfter.scroll.document, scrolledBefore.beforeNavigation.scroll.document, "Inner grid navigation must not scroll the document");
    assert.deepEqual(scrolledAfter.overflow, [], "Expanded grid must not introduce horizontal overflow");
    await scrollHomeToTop();
    await clickSectionToggle("recent");
    await waitFor("document.querySelector('.home-panel .recent-grid:not(.pinned-grid)')?.querySelectorAll(':scope > .recent-item-shell').length===9");
    const fallback = await assertCounts(12, 9, `recent collapsed after hidden selection ${width}/${theme}`);
    assert.ok(fallback.selected.index >= 0 && fallback.selected.index < 21, "Selection should fall back to a currently visible item after collapse");
    assert.notEqual(fallback.selected.label, "最近使用 24", "Collapsed hidden selection must not remain on a removed command");
    assert.ok(fallback.status.detail?.includes(fallback.selected.label || ""), `Status text must describe the fallback selection: ${JSON.stringify(fallback)}`);
    assert.deepEqual(fallback.overflow, []);
    checks.push({ kind: "expanded-navigation-and-collapse", width, theme, columns: recentExpanded.sections.find(section => section.kind === "recent").columns,
      tabFocusTrace: tabResult.trace, selectionBeforeTab: tabResult.initialSelection, selectionNormalizationPath: tabResult.selectionNormalizationPath,
      selectedRecentBeforePinExpansion: secondRecent.selected, selectedAfterPinExpansion: preserved.selected,
      hiddenSelectionBeforeCollapse: scrolledBefore.selected, safeFallback: fallback.selected, status: fallback.status,
      scrollBeforeNavigation: scrolledBefore.beforeNavigation.scroll, scrollAfterNavigation: scrolledAfter.scroll,
      screenshots: [collapsedShot.file, pinnedShot.file, recentShot.file, bothShot.file] });
    return { width, theme, collapsedShot, pinnedShot, recentShot, bothShot };
  }

  async function runSearchSelectionCase() {
    await setViewport(800, "light");
    await resetFixture();
    await click(INPUT);
    const start = await state();
    assert.equal(start.input.value, "");
    assert.equal(start.input.selectionStart, start.input.selectionEnd, "Search input must begin with a collapsed caret");
    await cdp("Input.insertText", { text: "fixture-query" });
    await waitFor("document.querySelectorAll('.result-row[role=option]').length===3");
    const before = await evaluate(`(()=>({value:document.querySelector('${INPUT}').value,selected:Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex)),labels:Array.from(document.querySelectorAll('.result-row[role=option]')).map(row=>row.getAttribute('aria-label')||row.textContent.trim())}))()`);
    assert.equal(before.value, "fixture-query", "CDP text insertion should reach the real search input");
    assert.deepEqual(before.selected, [0]);
    const preKeySelections = [await selectAllRealInputText()];
    await key("ArrowDown", "ArrowDown", 40);
    const afterArrowDown = await evaluate(`(()=>({selected:Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex)),count:document.querySelectorAll('.result-row[role=option]').length}))()`);
    assert.deepEqual(afterArrowDown.selected, [0], "ArrowDown must not move results while text is selected");
    assert.equal(afterArrowDown.count, 3);
    preKeySelections.push(await selectAllRealInputText());
    await key("ArrowUp", "ArrowUp", 38);
    const afterArrowUp = await evaluate(`(()=>({selected:Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex)),count:document.querySelectorAll('.result-row[role=option]').length}))()`);
    assert.deepEqual(afterArrowUp.selected, [0], "ArrowUp must not move results while text is selected");
    assert.equal(afterArrowUp.count, 3, "Arrow keys must not replace the fixed result set");
    preKeySelections.push(await selectAllRealInputText());
    await key("Enter", "Enter", 13);
    const afterEnter = await evaluate(`(()=>({activationCount:window.homeExpansionFixture.activationCount,selected:Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex))}))()`);
    assert.equal(afterEnter.activationCount, 0, "Enter with selected query text must not activate a search result");
    assert.deepEqual(afterEnter.selected, [0]);
    preKeySelections.push(await selectAllRealInputText());
    await key("End", "End", 35);
    const collapsedCaret = await readInputSelection();
    assert.equal(collapsedCaret.start, collapsedCaret.end, "End should collapse the real text selection to a caret");
    await key("ArrowDown", "ArrowDown", 40);
    const afterCollapsedDown = await evaluate(`Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex))`);
    assert.deepEqual(afterCollapsedDown, [1], "ArrowDown should resume result navigation after the caret is collapsed");
    await key("ArrowUp", "ArrowUp", 38);
    const final = await evaluate(`(()=>({selected:Array.from(document.querySelectorAll('.result-row[role=option][aria-selected=true]')).map(row=>Number(row.dataset.resultIndex)),activationCount:window.homeExpansionFixture.activationCount}))()`);
    assert.deepEqual(final.selected, [0]);
    assert.equal(final.activationCount, 0);
    checks.push({ kind: "search-selection-protection", insertedBy: "CDP Input.insertText", query: before.value,
      initialResultLabels: before.labels, preKeySelections, afterArrowDown, afterArrowUp,
      afterEnter, collapsedCaret, afterCollapsedArrowDown: afterCollapsedDown, final });
  }

  return {
    checks,
    screenshots,
    runLayoutCase,
    runSearchSelectionCase,
    evaluate,
    captureState: (timeoutMs = 2500) => state(timeoutMs),
    captureDiagnostics,
    cdp,
    waitFor,
    getSnapshot: () => ({ checks: structuredClone(checks), screenshots: structuredClone(screenshots), fixtureResets: structuredClone(fixtureResets) }),
    getLastResetPointer: () => structuredClone(lastResetPointer),
  };
}
