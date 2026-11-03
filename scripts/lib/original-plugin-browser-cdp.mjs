import assert from "node:assert/strict";
import { delay } from "../chrome-cdp-smoke-utils.mjs";

/** Only CDP input commands edit controls. Runtime evaluations observe DOM and coordinates. */
export function originalBrowserControls(page, report) {
  assert.equal(typeof page.remaining, "function", "Original controls require the bounded CDP transport");
  const contexts = new Map();
  function observeClient(client, sessionId = "main") {
    client.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.auxData?.isDefault) contexts.set(`${sessionId}:${context.id}`, { ...context, client, sessionId });
    });
    client.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(`${sessionId}:${executionContextId}`));
    client.on("Runtime.executionContextsCleared", () => { for (const [key, context] of contexts) if (context.sessionId === sessionId) contexts.delete(key); });
  }
  observeClient(page);
  async function evaluate(expression, contextId, client = page) {
    const result = await client.send("Runtime.evaluate", { expression, ...(contextId ? { contextId } : {}),
      awaitPromise: true, returnByValue: true, userGesture: false }, { timeoutMs: 12000 });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || "Browser evaluation failed");
    return result.result.value;
  }
  async function wait(read, label, timeoutMs = 12000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const result = await read(); if (result) return result; await delay(30); }
    throw Error("Timed out waiting for " + label);
  }
  async function key(key, code, keyCode, modifiers = 0) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers,
      ...(key === "a" && modifiers === 4 ? { commands: ["selectAll"] } : {}),
      ...(key === "Enter" && modifiers === 0 ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await delay(20);
  }
  async function point(selector, document) {
    const expression = `(()=>{const nodes=document.querySelectorAll(${JSON.stringify(selector)});if(nodes.length!==1)return null;const e=nodes[0],r=e.getBoundingClientRect();
      if(e.disabled||e.readOnly||r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return null;
      const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===e||e.contains(hit)))return null;
      return {x,y,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},tag:e.tagName};})()`;
    const local = document ? await document.read(expression) : await evaluate(expression);
    assert.ok(local, "Exactly one available hit-tested control required: " + selector);
    if (!document) return local;
    const frame = await evaluate(`(()=>{const f=document.querySelectorAll('iframe[title="Plugin"]');if(f.length!==1)return null;const r=f[0].getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`);
    assert.ok(frame, "Exactly one actual PluginPanel iframe required");
    assert.ok(local.x < frame.width && local.y < frame.height, "Original control outside iframe viewport");
    return { ...local, x: local.x + frame.left, y: local.y + frame.top, frame };
  }
  async function click(selector, document) {
    const p = await point(selector, document);
    report.inputs.push({ kind: "pointer", selector, contextId: document?.contextId || "main", point: p });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
    await delay(35);
  }
  async function type(selector, text, document) {
    await click(selector, document);
    const read = expression => document ? document.read(expression) : evaluate(expression);
    const input = `document.querySelector(${JSON.stringify(selector)})`;
    await wait(() => read(`document.activeElement===${input}`), "trusted pointer to focus " + selector);
    if (await read(`${input}.value.length>0`)) {
      await key("a", "KeyA", 65, 4);
      await wait(() => read(`(${input}.selectionStart===0&&${input}.selectionEnd===${input}.value.length)||(${input}.type==='number'&&${input}.selectionStart===null&&${input}.selectionEnd===null)`), "actual select-all range or number input without selection API");
      await key("Backspace", "Backspace", 8);
      await wait(() => read(`${input}.value===''`), "actual Backspace clears control");
    }
    await page.send("Input.insertText", { text });
    await wait(() => read(`${input}.value===${JSON.stringify(text)}`), "trusted CDP text reaches " + selector);
    report.inputs.push({ kind: "text", selector, text, contextId: document?.contextId || "main", mechanism: "CDP selectAll/Backspace/Input.insertText" });
  }
  async function bindOriginalDocument(marker) {
    return wait(async () => {
      for (const [contextKey, context] of contexts) {
        try {
          const contextId = context.id;
          const state = await evaluate(`(()=>({marker:!!document.querySelector(${JSON.stringify(marker)}),nonce:window.__originalBusinessBrowserObservation?.nonce,url:document.URL,focused:document.hasFocus(),visibility:document.visibilityState}))()`, contextId, context.client);
          if (!state.marker || !state.nonce) continue;
          const identity = { contextId, sessionId: context.sessionId, frameId: context.auxData.frameId, nonce: state.nonce, url: state.url };
          report.documents.push(identity);
          return { ...identity, async read(expression) {
            assert.ok(contexts.has(contextKey), "Bound original execution context was destroyed");
            const result = await evaluate(`({nonce:window.__originalBusinessBrowserObservation?.nonce,value:(${expression})})`, contextId, context.client);
            assert.equal(result.nonce, identity.nonce, "Original document nonce changed");
            return result.value;
          } };
        } catch { /* The old srcdoc can disappear while the actual loader replaces it. */ }
      }
      return null;
    }, "current original iframe document " + marker);
  }
  return { evaluate, wait, key, point, click, type, bindOriginalDocument, observeClient };
}

export const originalEventObservationSource = `(()=>{if(window.__originalBusinessBrowserObservation)return;const observation={nonce:[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join(''),events:[]};
  Object.defineProperty(window,'__originalBusinessBrowserObservation',{value:observation});
  for(const type of ['pointerdown','keydown','beforeinput','input'])document.addEventListener(type,event=>{
    const node=event.target;observation.events.push({type,trusted:event.isTrusted,target:node?.id||node?.getAttribute?.('aria-label')||node?.tagName||'',...(type==='keydown'?{key:event.key}:{})});
  },true);})();`;
