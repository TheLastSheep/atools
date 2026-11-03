import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const SETTINGS_ROOT = "#settings-app";
const THEME_LABEL = "主题设置";
const TRAY_LABEL = "显示托盘图标";
const AUTHORITATIVE = { theme: "dark", recentRows: 4, pinnedRows: 3 };
const STALE = { theme: "light", recentRows: 1, pinnedRows: 1 };
const STALE_CACHE = { ...STALE, showTrayIcon: false };
const RAW_CAUSE = "private-fixture-native-read-cause";

export function createSettingsLoadingScenarios({ page, outputDir, runId, delay }) {
  const checks = [];
  const screenshots = [];

  async function cdp(method, params = {}, timeoutMs = 12000) {
    return page.send(method, params, { timeoutMs });
  }

  async function evaluate(expression, timeoutMs = 12000) {
    const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || "Browser expression failed");
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

  async function waitForVisualStability(timeoutMs = 3000) {
    const result = await evaluate(`(async()=>{
      const bounded=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve({timeout:true}),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve({value})},error=>{clearTimeout(timer);resolve({error:String(error)})})});
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      const fonts=await bounded(document.fonts?.ready??Promise.resolve(),${timeoutMs});
      if(fonts.timeout||fonts.error)return{fontsReady:false,reason:fonts.timeout?'timeout':fonts.error};
      await frame();await frame();
      const root=document.querySelector('${SETTINGS_ROOT}'),panel=document.querySelector('.settings-panel');
      if(!root||!panel)return{fontsReady:true,missingRoot:!root,missingPanel:!panel};
      const finite=()=>root.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations));
      const animations=finite(),finished=await bounded(Promise.all(animations.map(animation=>animation.finished.catch(()=>undefined))),${timeoutMs});
      if(finished.timeout||finished.error)return{fontsReady:true,animationCount:animations.length,animationsFinished:false,reason:finished.timeout?'timeout':finished.error};
      await frame();await frame();
      const read=element=>{const style=getComputedStyle(element);return{opacity:Number(style.opacity),transform:style.transform}};
      const rootBefore=read(root),panelBefore=read(panel);await frame();await frame();
      const rootAfter=read(root),panelAfter=read(panel);
      const same=(a,b)=>Math.abs(a.opacity-b.opacity)<=0.001&&a.transform===b.transform;
      const activeAnimations=finite().filter(animation=>animation.playState!=='finished'&&animation.playState!=='idle').length;
      return{fontsReady:true,animationCount:animations.length,animationsFinished:activeAnimations===0,activeAnimations,
        root:{before:rootBefore,after:rootAfter,stable:same(rootBefore,rootAfter)},
        panel:{before:panelBefore,after:panelAfter,stable:same(panelBefore,panelAfter)}};
    })()`);
    assert.equal(result.fontsReady, true, `Fonts should settle before the settings screenshot: ${JSON.stringify(result)}`);
    assert.equal(result.animationsFinished, true, `Finite settings mount animations should finish: ${JSON.stringify(result)}`);
    assert.equal(result.root?.stable, true, `Fixture root opacity/transform should be stable: ${JSON.stringify(result)}`);
    assert.equal(result.panel?.stable, true, `Settings panel opacity/transform should be stable: ${JSON.stringify(result)}`);
    assert.ok(result.root.after.opacity >= 0.99 && result.panel.after.opacity >= 0.99, "Settings screenshot should show fully opaque settled content");
    assert.ok([result.root.after.transform, result.panel.after.transform].every(value => value === "none" || value === "matrix(1, 0, 0, 1, 0, 0)"),
      `Settings elements should return to resting transforms: ${JSON.stringify(result)}`);
    return result;
  }

  async function setViewport(width, height, theme) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await waitFor(`innerWidth===${width}&&innerHeight===${height}`);
    await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,500))])");
  }

  async function fixtureSnapshot() {
    return evaluate("window.settingsLoadingFixture?.snapshot?.()??null");
  }

  async function pressKey(key) {
    const map = { Tab: 9 };
    const virtualKey = map[key];
    assert.ok(virtualKey, `Unsupported acceptance key: ${key}`);
    const params = { key, code: key, windowsVirtualKeyCode: virtualKey };
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await delay(70);
  }

  async function clickSelector(selector) {
    const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
    assert.ok(rect && rect.width > 0 && rect.height > 0, `Could not find visible click target ${selector}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await delay(65);
  }

  async function trayToggleTargetState() {
    return evaluate(`(()=>{
      const item=[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()==='${TRAY_LABEL}');
      const control=item?.querySelector('input[type=checkbox]');
      if(!control)return{viewport:{width:innerWidth,height:innerHeight},rect:null,active:false,checked:null,centerHitIsControl:false,allSampleHitsControl:false};
      const r=control.getBoundingClientRect(),center={x:r.left+r.width/2,y:r.top+r.height/2};
      const points=[center,{x:r.left+2,y:r.top+2},{x:r.right-2,y:r.top+2},{x:r.left+2,y:r.bottom-2},{x:r.right-2,y:r.bottom-2}];
      const hit=point=>document.elementFromPoint(point.x,point.y);
      const belongs=node=>Boolean(node&&(node===control||control.contains(node)));
      const hits=points.map(point=>{const node=hit(point);return{tag:node?.tagName||null,id:node?.id||null,className:typeof node?.className==='string'?node.className:null,isControl:belongs(node)}});
      return{viewport:{width:innerWidth,height:innerHeight},rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},center,checked:control.checked,
        fullyInsideViewport:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
        active:document.activeElement===control,centerHitIsControl:hits[0].isControl,allSampleHitsControl:hits.every(entry=>entry.isControl),hits};
    })()`);
  }

  async function clickTrayToggle() {
    const beforeScroll = await trayToggleTargetState();
    assert.ok(beforeScroll.rect, "The tray toggle should exist before scrolling it into the viewport");
    assert.equal(beforeScroll.checked, false, "The tray toggle must start false so the pointer action changes it to true");
    await evaluate(`(()=>{const item=[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()==='${TRAY_LABEL}');item?.querySelector('input[type=checkbox]')?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})})()`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await delay(80);
    const target = await trayToggleTargetState();
    assert.equal(target.fullyInsideViewport, true, `The entire tray input must be in the 600px viewport before clicking: ${JSON.stringify(target)}`);
    assert.equal(target.centerHitIsControl, true, `The center of the tray input must be the actual hit target: ${JSON.stringify(target)}`);
    assert.equal(target.allSampleHitsControl, true, `The visible tray input surface must not be covered: ${JSON.stringify(target)}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.center.x, y: target.center.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: target.center.x, y: target.center.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.center.x, y: target.center.y, button: "left", clickCount: 1 });
    const focus = await trayToggleTargetState();
    assert.equal(focus.active, true, `A real pointer click should focus the tray checkbox: ${JSON.stringify(focus)}`);
    assert.equal(focus.checked, true, `A real pointer click should change the tray checkbox to true: ${JSON.stringify(focus)}`);
    const interaction = { beforeScroll, target, focus };
    checks.push({ kind: "tray-checkbox-real-pointer-target", ...interaction });
    return interaction;
  }

  async function saveScreenshot(name) {
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = join(outputDir, `${name}-${runId}.png`);
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(file, bytes);
    const shot = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    screenshots.push(shot);
    return shot;
  }

  async function captureGate(state, tag) {
    const measurement = await evaluate(`(async()=>{
      const bounded=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);Promise.resolve(promise).then(()=>{clearTimeout(timer);resolve(true)},()=>{clearTimeout(timer);resolve(false)})});
      const fontsReady=await bounded(document.fonts?.ready??Promise.resolve(),2500);
      if(!fontsReady)return{fontsReady:false,frames:0};
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const gate=document.querySelector('.editing-gate'),retry=gate?.querySelector('button'),rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      const gateRect=rect(gate),retryButtonRect=rect(retry),viewport={width:innerWidth,height:innerHeight};
      const visible=r=>Boolean(r&&r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight);
      const insideGate=Boolean(gateRect&&retryButtonRect&&retryButtonRect.left>=gateRect.left&&retryButtonRect.top>=gateRect.top&&retryButtonRect.right<=gateRect.right&&retryButtonRect.bottom<=gateRect.bottom);
      return{fontsReady,frames:2,viewport,gateRole:gate?.getAttribute('role')||null,gateText:gate?.textContent.trim()||null,gateRect,retryButtonText:retry?.textContent.trim()||null,retryButtonRect,
        gateFullyVisible:visible(gateRect),retryButtonFullyVisible:retry?visible(retryButtonRect):null,retryButtonInsideGate:retry?insideGate:null};
    })()`);
    assert.equal(measurement.fontsReady, true, "Gate screenshots must wait for document fonts");
    assert.equal(measurement.frames, 2, "Gate screenshots must wait two animation frames after fonts load");
    assert.deepEqual(measurement.viewport, { width: 800, height: 600 }, "Gate screenshots use the default settings viewport");
    assert.equal(measurement.gateRole, state === "error" ? "alert" : "status");
    assert.equal(measurement.gateFullyVisible, true, `The ${state} gate must be fully visible: ${JSON.stringify(measurement)}`);
    if (state === "error") {
      assert.equal(measurement.retryButtonText, "重试");
      assert.equal(measurement.retryButtonFullyVisible, true, `The retry button must be fully visible: ${JSON.stringify(measurement)}`);
      assert.equal(measurement.retryButtonInsideGate, true, `The retry button must remain inside the error gate: ${JSON.stringify(measurement)}`);
    } else {
      assert.equal(measurement.retryButtonRect, null);
    }
    const screenshot = await saveScreenshot(`settings-gate-${state}-${tag}`);
    checks.push({ kind: `settings-gate-${state}-layout`, measurement, screenshot });
    return { measurement, screenshot };
  }

  async function captureLayout(width, theme, tag) {
    const visualStability = await waitForVisualStability();
    const state = await evaluate(`(()=>{
      const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      const setting=label=>[...document.querySelectorAll('.settings-panel .setting-item')].find(item=>item.querySelector('.setting-label span')?.textContent.trim()===label);
      const value=label=>setting(label)?.querySelector('select')?.value??null;
      const panel=document.querySelector('.settings-panel'),sidebar=document.querySelector('.settings-sidebar'),content=document.querySelector('.settings-content'),themeSelect=setting('${THEME_LABEL}')?.querySelector('select');
      const active=document.activeElement;
      return{viewport:{width:innerWidth,height:innerHeight},root:rect(document.querySelector('${SETTINGS_ROOT}')),panel:rect(panel),sidebar:rect(sidebar),content:rect(content),
        theme:value('${THEME_LABEL}'),recentRows:value('最近使用显示行数'),pinnedRows:value('固定栏显示行数'),tray:setting('${TRAY_LABEL}')?.querySelector('input[type=checkbox]')?.checked??null,
        activeElement:active?{tag:active.tagName,role:active.getAttribute('role'),label:active.getAttribute('aria-label'),text:active.textContent?.trim().slice(0,80)||null}:null,
        themeSelect:rect(themeSelect),document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,scrollTop:document.scrollingElement?.scrollTop||0},
        overflow:{documentX:document.documentElement.scrollWidth>innerWidth+1,bodyX:document.body.scrollWidth>innerWidth+1,appX:document.querySelector('${SETTINGS_ROOT}')?.scrollWidth>document.querySelector('${SETTINGS_ROOT}')?.clientWidth+1,
          panelX:panel?.scrollWidth>panel?.clientWidth+1,sidebarX:sidebar?.scrollWidth>sidebar?.clientWidth+1,contentX:content?.scrollWidth>content?.clientWidth+1,
          sidebarScrollWidth:sidebar?.scrollWidth||0,sidebarClientWidth:sidebar?.clientWidth||0,contentScrollHeight:content?.scrollHeight||0,contentClientHeight:content?.clientHeight||0}};
    })()`);
    assert.ok(state.panel && state.panel.left >= -1 && state.panel.right <= width + 1, `Settings panel should fit width ${width}: ${JSON.stringify(state.panel)}`);
    assert.ok(state.panel.top >= -1 && state.panel.bottom <= state.viewport.height + 1, "Settings panel should remain within its viewport");
    assert.equal(state.overflow.documentX, false, "The settings page must not horizontally scroll the document");
    assert.equal(state.overflow.bodyX, false, "The settings page must not horizontally scroll the body");
    assert.equal(state.overflow.appX, false, "The settings host must not horizontally overflow");
    assert.equal(state.overflow.panelX, false, "The settings panel must not horizontally overflow");
    const shot = await saveScreenshot(`settings-${width}-${theme}-${tag}`);
    checks.push({ kind: "settings-panel-layout", width, theme, tag, visualStability, screenshot: shot.file, measurement: state });
    return state;
  }

  async function waitForGateState(role) {
    const selector = role === "error" ? ".editing-gate[role=alert]" : ".editing-gate[role=status]";
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    const state = await evaluate(`(()=>({gate:document.querySelector('.editing-gate')?.textContent.trim()||null,
      role:document.querySelector('.editing-gate')?.getAttribute('role')||null,
      panelCount:document.querySelectorAll('.settings-panel').length,sidebarCount:document.querySelectorAll('.settings-sidebar').length,
      savedStatus:Boolean(document.querySelector('.settings-panel .save-status')?.textContent.includes('已保存')),
      staleText:document.body.textContent.includes('stale-local-cache-must-not-appear')}))()`);
    assert.equal(state.role, role === "error" ? "alert" : "status", "Gate role should match its loading or error state");
    assert.ok(state.gate && (role === "error" ? state.gate.includes("设置加载失败") : state.gate.includes("正在读取设置")),
      `Gate should show only the expected ${role} copy: ${JSON.stringify(state.gate)}`);
    assert.equal(state.panelCount, 0, "SettingsPanel must not mount while the strict settings read is unresolved or failed");
    assert.equal(state.sidebarCount, 0, "Settings navigation must not appear before authoritative settings are available");
    assert.equal(state.savedStatus, false, "The loading/error gate must not claim settings are saved");
    assert.equal(state.staleText, false, "The stale local cache must not appear in the loading/error gate");
    return state;
  }

  async function waitForPanel(expected = AUTHORITATIVE, expectedTray = false) {
    await waitFor("document.querySelectorAll('.settings-panel').length===1&&document.querySelector('.settings-panel .settings-sidebar')");
    await waitFor("document.querySelector('.settings-panel .settings-sidebar .save-status')?.textContent.trim()==='已保存'");
    const values = await evaluate(`(()=>{const item=label=>[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()===label);return{theme:item('${THEME_LABEL}')?.querySelector('select')?.value??null,
      recentRows:item('最近使用显示行数')?.querySelector('select')?.value??null,pinnedRows:item('固定栏显示行数')?.querySelector('select')?.value??null,
      showTrayIcon:item('${TRAY_LABEL}')?.querySelector('input[type=checkbox]')?.checked??null,
      menu:document.querySelector('.settings-sidebar .menu-item.active')?.textContent.trim()||null,panelCount:document.querySelectorAll('.settings-panel').length}})()`);
    assert.equal(values.panelCount, 1, "Success should mount exactly one real SettingsPanel");
    assert.deepEqual({ theme: values.theme, recentRows: Number(values.recentRows), pinnedRows: Number(values.pinnedRows) }, expected,
      `The form should use authoritative native settings rather than the stale local cache ${JSON.stringify(STALE)}`);
    assert.equal(values.showTrayIcon, expectedTray, `The authoritative tray setting should be ${expectedTray}`);
    return values;
  }

  async function runStaleSessionAndSave() {
    await waitFor("window.settingsLoadingFixture && window.settingsLoadingFixture.snapshot().readCalls.length===1");
    await setViewport(800, 600, "light");
    const pending = await waitForGateState("loading");
    await captureGate("loading", "first-native-read");
    let state = await fixtureSnapshot();
    assert.deepEqual(state.readCalls.map(read => read.status), ["pending"]);
    assert.equal(state.settingsWrites.length, 0);
    assert.equal(state.nativeWrites.length, 0);
    checks.push({ kind: "strict-read-pending-gate", pending, readCount: state.readCalls.length, staleLocalCache: state.staleLocalCache });

    assert.equal(await evaluate("window.settingsLoadingFixture.remountSystemPanel()"), true, "A newer SystemPanel session should mount after unmounting the pending session");
    await waitFor("window.settingsLoadingFixture.snapshot().readCalls.length===2");
    await waitForGateState("loading");
    assert.equal(await evaluate("window.settingsLoadingFixture.resolveRead(2,'authoritative')"), true);
    const loaded = await waitForPanel();
    state = await fixtureSnapshot();
    assert.deepEqual(state.readCalls.map(read => read.status), ["pending", "resolved"]);
    assert.equal(state.readCalls.length, 2, "SettingsPanel hydration should reuse its active read lease, not read native settings again");
    assert.deepEqual(state.nativeWrites, [], "Opening settings must not apply system writes");
    assert.equal(state.settingsWrites.length, 0, "Opening settings must not persist settings");
    await pressKey("Tab");
    const keyboardEntry = await evaluate(`(()=>{const active=document.activeElement;const rect=active?.getBoundingClientRect();return{isSettingsMenu:!!active?.matches('.settings-sidebar .menu-item'),visible:!!rect&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight,label:active?.textContent?.trim()||null}})()`);
    assert.equal(keyboardEntry.isSettingsMenu, true, `A real Tab should reach the settings navigation: ${JSON.stringify(keyboardEntry)}`);
    assert.equal(keyboardEntry.visible, true, `The focused settings navigation item should be visible: ${JSON.stringify(keyboardEntry)}`);
    checks.push({ kind: "keyboard-reaches-settings-navigation", focus: keyboardEntry });

    assert.equal(await evaluate("window.settingsLoadingFixture.resolveRead(1,'stale')"), true, "The late reply from the unmounted session should be delivered for stale-result validation");
    await delay(150);
    const afterStale = await fixtureSnapshot();
    const loadedAfterStale = await waitForPanel();
    assert.equal(afterStale.activeReadLease.theme, "dark", "A delayed old response must not replace the newer session lease");
    assert.deepEqual({ theme: loadedAfterStale.theme, recentRows: Number(loadedAfterStale.recentRows), pinnedRows: Number(loadedAfterStale.pinnedRows) }, AUTHORITATIVE);
    assert.equal(afterStale.settingsWrites.length, 0, "A stale settings response must not write settings");
    checks.push({ kind: "stale-reply-cannot-replace-active-session", reads: afterStale.readCalls, activeReadLease: afterStale.activeReadLease });

    await setViewport(800, 600, "dark");
    const dark800 = await captureLayout(800, "dark", "authoritative-first-ready");
    assert.equal(dark800.theme, "dark");
    assert.equal(dark800.tray, false);
    await setViewport(420, 600, "dark");
    const dark420 = await captureLayout(420, "dark", "authoritative-first-ready");
    assert.equal(dark420.theme, "dark");
    assert.equal(dark420.tray, false);
    await setViewport(800, 600, "dark");

    await clickTrayToggle();
    await waitFor(`(()=>{const item=[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()==='${TRAY_LABEL}');return item?.querySelector('input[type=checkbox]')?.checked===true})()`);
    await waitFor("window.settingsLoadingFixture.snapshot().settingsWrites.length===1", 5000);
    await waitFor("document.querySelector('.settings-panel .settings-sidebar .save-status')?.textContent.trim()==='已保存'", 5000);
    await delay(250);
    state = await fixtureSnapshot();
    assert.equal(state.readCalls.length, 2, "Editing the hydrated form must not issue another settings read");
    assert.equal(state.settingsWrites.length, 1, "One tray toggle should persist exactly one full settings snapshot");
    assert.deepEqual(state.settingsWrites[0].value, state.expectedAfterTrayChange, "The write should preserve every authoritative setting while changing only the tray preference");
    assert.deepEqual(state.nativeWrites.map(call => call.command), ["save_general_settings"], "One settings edit should use the atomic Native transaction exactly once");
    assert.deepEqual(state.nativeWrites[0].args.expected, { raw: state.authoritativeRaw }, "The save must compare against the editor's original raw snapshot");
    assert.equal(state.nativeWrites[0].args.applyNative, true);
    assert.deepEqual(state.nativeWrites[0].args.changes, state.expectedAfterTrayChange);
    checks.push({ kind: "single-control-change-preserves-full-settings", readCount: state.readCalls.length, settingsWriteCount: state.settingsWrites.length,
      changedSetting: "showTrayIcon", preservedTheme: state.settingsWrites[0].value.theme, showTrayIcon: state.settingsWrites[0].value.showTrayIcon,
      preserved: { recentRows: state.settingsWrites[0].value.recentRows, pinnedRows: state.settingsWrites[0].value.pinnedRows } });

    await evaluate("window.settingsLoadingFixture.unmountSystemPanel()");
    await waitFor("window.settingsLoadingFixture.snapshot().activeReadLease===null");
    await evaluate("window.settingsLoadingFixture.seedStaleLocalCache()");
    await evaluate("window.settingsLoadingFixture.mountSystemPanel()");
    await waitFor("window.settingsLoadingFixture.snapshot().readCalls.length===3");
    await waitForGateState("loading");
    const writesBeforeLate = (await fixtureSnapshot()).settingsWrites.length;
    await evaluate("window.settingsLoadingFixture.unmountSystemPanel()");
    await waitFor("document.querySelectorAll('.settings-panel').length===0");
    assert.equal(await evaluate("window.settingsLoadingFixture.resolveRead(3,'stale')"), true);
    await delay(200);
    state = await fixtureSnapshot();
    assert.equal(state.activeReadLease, null, "An unmounted pending settings open must close any lease when its late read resolves");
    assert.equal(state.settingsWrites.length, writesBeforeLate, "A late reply after unmount must not trigger a settings write");
    checks.push({ kind: "unmount-before-read-reply-has-no-late-write", readId: 3, activeReadLease: state.activeReadLease, settingsWriteCount: state.settingsWrites.length });
    return { loaded, staleReply: afterStale.activeReadLease, saveCount: state.settingsWrites.length };
  }

  async function runFailureAndRetry() {
    await evaluate("window.settingsLoadingFixture.seedStaleLocalCache()");
    await evaluate("window.settingsLoadingFixture.mountSystemPanel()");
    await waitFor("window.settingsLoadingFixture.snapshot().readCalls.length===4");
    await setViewport(800, 600, "dark");
    const pending = await waitForGateState("loading");
    const before = await fixtureSnapshot();
    assert.equal(before.settingsWrites.length, 1);
    assert.equal(before.nativeWrites.length, 1);
    assert.equal(await evaluate("window.settingsLoadingFixture.rejectRead(4)"), true);
    const error = await waitForGateState("error");
    await captureGate("error", "native-read-failure");
    assert.ok(error.gate.includes("设置加载失败") && error.gate.includes("设置暂不可用，请重试。"));
    assert.equal(error.gate.includes(RAW_CAUSE), false, "The gate must not show the native failure cause");
    let state = await fixtureSnapshot();
    assert.equal(state.settingsWrites.length, 1, "A failed settings read must not write to native settings");
    assert.equal(state.nativeWrites.length, 1, "A failed settings read must not apply native preferences");
    checks.push({ kind: "failed-read-is-sanitized-without-writes", gate: error.gate, readId: 4, rawCauseVisible: error.gate.includes(RAW_CAUSE) });

    await clickSelector(".editing-gate[role=alert] button");
    await waitFor("window.settingsLoadingFixture.snapshot().readCalls.length===5");
    await waitForGateState("loading");
    assert.equal(await evaluate("window.settingsLoadingFixture.resolveRead(5,'current')"), true);
    const loaded = await waitForPanel(AUTHORITATIVE, true);
    state = await fixtureSnapshot();
    assert.equal(state.readCalls.length, 5, "Explicit retry should perform one new read and panel hydration should reuse it");
    assert.equal(state.readCalls[3].status, "rejected");
    assert.equal(state.readCalls[4].status, "resolved");
    assert.equal(state.settingsWrites.length, 1, "Recovering from a read failure must not persist an unchanged settings snapshot");
    assert.equal(state.nativeWrites.length, 1);
    assert.deepEqual({ theme: loaded.theme, recentRows: Number(loaded.recentRows), pinnedRows: Number(loaded.pinnedRows) }, AUTHORITATIVE);
    await setViewport(800, 600, "dark");
    const dark800 = await captureLayout(800, "dark", "retry-committed-ready");
    assert.equal(dark800.theme, "dark");
    assert.equal(dark800.tray, true);
    await setViewport(420, 600, "dark");
    const dark420 = await captureLayout(420, "dark", "retry-committed-ready");
    assert.equal(dark420.theme, "dark");
    assert.equal(dark420.tray, true);
    checks.push({ kind: "explicit-retry-recovers-committed-settings", reads: state.readCalls.slice(3), loaded, settingsWriteCount: state.settingsWrites.length });
    await evaluate("window.settingsLoadingFixture.unmountSystemPanel()");
    await waitFor("window.settingsLoadingFixture.snapshot().activeReadLease===null");
    return { pending, error: error.gate, loaded };
  }

  async function runBaselineRiskReproduction() {
    await setViewport(800, 600, "light");
    await waitFor("window.settingsLoadingFixture && window.settingsLoadingFixture.snapshot().readCalls.length===1");
    await waitFor("document.querySelector('.settings-panel .settings-sidebar .save-status')?.textContent.trim()==='已保存'");
    const readForm = () => evaluate(`(()=>{const item=label=>[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()===label);return{theme:item('${THEME_LABEL}')?.querySelector('select')?.value??null,recentRows:Number(item('最近使用显示行数')?.querySelector('select')?.value),pinnedRows:Number(item('固定栏显示行数')?.querySelector('select')?.value),showTrayIcon:item('${TRAY_LABEL}')?.querySelector('input[type=checkbox]')?.checked??null,saveStatus:document.querySelector('.settings-panel .settings-sidebar .save-status')?.textContent.trim()||null}})()`);
    let state = await fixtureSnapshot();
    const before = await readForm();
    assert.deepEqual(state.baselineValues, STALE_CACHE, "The private stale cache seed should be the declared light/one-row/tray-off snapshot");
    assert.deepEqual(state.readCalls.map(read => read.status), ["pending"], "The original native settings reply must still be pending when the stale form is editable");
    assert.deepEqual({ theme: before.theme, recentRows: before.recentRows, pinnedRows: before.pinnedRows }, STALE,
      "The baseline SettingsPanel should expose its local cache before the pending native settings reply");
    assert.equal(before.showTrayIcon, false, "The baseline tray setting should begin disabled");
    assert.equal(before.saveStatus, "已保存", "The baseline should visibly report saved state while native settings are still pending");
    assert.deepEqual(state.settingsWrites, []);
    assert.deepEqual(state.nativeWrites, []);
    checks.push({ kind: "baseline-editable-stale-form-before-native-reply", form: before, readCalls: state.readCalls });

    await clickTrayToggle();
    await waitFor(`(()=>{const item=[...document.querySelectorAll('.settings-panel .setting-item')].find(entry=>entry.querySelector('.setting-label span')?.textContent.trim()==='${TRAY_LABEL}');return item?.querySelector('input[type=checkbox]')?.checked===true})()`);
    await waitFor("window.settingsLoadingFixture.snapshot().settingsWrites.length===1", 5000);
    await waitFor("document.querySelector('.settings-panel .settings-sidebar .save-status')?.textContent.trim()==='已保存'", 5000);
    await delay(250);
    state = await fixtureSnapshot();
    assert.deepEqual(state.readCalls.map(read => read.status), ["pending"], "The native read must remain unresolved while the first edit is persisted");
    assert.equal(state.settingsWrites.length, 1, "The baseline edit should produce exactly one native settings write");
    assert.deepEqual(state.settingsWrites[0].value, state.expectedAfterStaleTrayChange,
      "The first edit should persist the full snapshot seeded from stale local storage");
    assert.deepEqual({ theme: state.settingsWrites[0].value.theme, recentRows: state.settingsWrites[0].value.recentRows, pinnedRows: state.settingsWrites[0].value.pinnedRows }, STALE,
      "The tray-only edit should overwrite native theme and rows with untouched stale values");
    assert.equal(state.settingsWrites[0].value.showTrayIcon, true);
    assert.equal(state.nativeWrites.length, 6, "The original full native preference batch should be invoked once");
    assert.deepEqual(state.nativeWrites.find(call => call.command === "set_tray_icon_visible")?.args, { visible: true });
    const beforeReplyShot = await captureLayout(800, "light", "baseline-edit-before-native-reply");
    assert.deepEqual({ theme: beforeReplyShot.theme, recentRows: Number(beforeReplyShot.recentRows), pinnedRows: Number(beforeReplyShot.pinnedRows) }, STALE);
    assert.equal(beforeReplyShot.tray, true);

    assert.equal(await evaluate("window.settingsLoadingFixture.resolveRead(1,'authoritative')"), true);
    await waitFor("window.settingsLoadingFixture.snapshot().readCalls[0].status==='resolved'");
    await delay(150);
    const afterReply = await readForm();
    state = await fixtureSnapshot();
    assert.deepEqual({ theme: afterReply.theme, recentRows: afterReply.recentRows, pinnedRows: afterReply.pinnedRows }, STALE,
      "The dirty baseline form should ignore the later authoritative read and retain stale theme/rows");
    assert.equal(afterReply.showTrayIcon, true);
    assert.deepEqual(state.readCalls[0].settings, AUTHORITATIVE, "The deferred reply should contain the distinct authoritative native values");
    assert.equal(state.settingsWrites.length, 1, "The delayed native reply should not create another write");
    const afterReplyShot = await captureLayout(800, "light", "baseline-stale-untouched-settings-retained");
    assert.equal(afterReplyShot.tray, true);
    const overwrittenUntouchedFields = {
      fields: ["theme", "recentRows", "pinnedRows"],
      nativeReply: { theme: state.readCalls[0].settings.theme, recentRows: state.readCalls[0].settings.recentRows, pinnedRows: state.readCalls[0].settings.pinnedRows },
      persisted: { theme: state.settingsWrites[0].value.theme, recentRows: state.settingsWrites[0].value.recentRows, pinnedRows: state.settingsWrites[0].value.pinnedRows },
      visibleAfterReply: { theme: afterReply.theme, recentRows: afterReply.recentRows, pinnedRows: afterReply.pinnedRows },
    };
    checks.push({ kind: "baseline-reproduced-stale-full-snapshot-overwrite", changedSetting: "showTrayIcon", overwrittenUntouchedFields, settingsWriteCount: state.settingsWrites.length });
    return { riskReproduced: true, acceptancePassed: false, overwrittenUntouchedFields, nativeReadReply: state.readCalls[0].settings };
  }

  async function captureDiagnostics(timeoutMs = 2500) {
    return {
      state: await evaluate(`(()=>({viewport:{width:innerWidth,height:innerHeight},gate:document.querySelector('.editing-gate')?.outerHTML||null,
        panel:document.querySelector('.settings-panel')?{theme:[...document.querySelectorAll('.settings-panel .setting-item')].find(item=>item.querySelector('.setting-label span')?.textContent.trim()==='主题设置')?.querySelector('select')?.value??null,
          text:document.querySelector('.settings-panel')?.textContent.slice(0,500)||null}:null}))()`, timeoutMs).catch(error => ({ error: String(error) })),
      trayTarget: await trayToggleTargetState().catch(error => ({ error: String(error) })),
      fixtureSnapshot: await fixtureSnapshot().catch(error => ({ error: String(error) })),
    };
  }

  async function run() {
    const staleSession = await runStaleSessionAndSave();
    const retry = await runFailureAndRetry();
    return { staleSession, retry };
  }

  return { run, runBaselineRiskReproduction, waitFor, evaluate, captureDiagnostics, getSnapshot: () => ({ checks, screenshots }) };
}
