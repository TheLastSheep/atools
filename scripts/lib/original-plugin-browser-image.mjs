import assert from "node:assert/strict";

const imageState = `(()=>{const canvas=document.querySelector('#canvas'),style=canvas?getComputedStyle(canvas):null;
  const visible=!!canvas&&style.display!=='none';return {visible,width:canvas?.width,height:canvas?.height,
  imageCount:document.querySelectorAll('#image-list .image-item').length,labels:[...document.querySelectorAll('#image-list .image-info')].map(e=>e.textContent),
  placeholderVisible:!!document.querySelector('#preview-placeholder')&&getComputedStyle(document.querySelector('#preview-placeholder')).display!=='none',
  left:visible?[...canvas.getContext('2d').getImageData(0,0,1,1).data]:null,
  right:visible?[...canvas.getContext('2d').getImageData(31,15,1,1).data]:null,
  nodeProcessPid:window.process?.pid,bufferType:typeof window.Buffer,events:window.__originalBusinessBrowserObservation.events}})()`;
export function assertOriginalImageCanvas(state) {
  assert.equal(state.visible, true); assert.equal(state.width, 32); assert.equal(state.height, 16);
  assert.equal(state.imageCount, 1); assert.equal(state.placeholderVisible, false);
  assert.deepEqual(state.left, [255, 0, 0, 255]); assert.deepEqual(state.right, [0, 255, 0, 255]);
  assert.deepEqual(state.labels, ["粘贴图片 (32×16)"]);
}
export async function runOriginalImageBrowser(control, report) {
  report.imageInputProvisions = [];
  const states = {};
  async function open(label) {
    report.phase = "image-" + label;
    await control.click('[role="combobox"]');
    const provision = await control.evaluate("window.fixture.provideOriginalImagePaste()");
    assert.equal(provision.isTrusted, false); assert.equal(provision.fileCount, 1); assert.equal(provision.bytes, 93);
    report.imageInputProvisions.push(provision);
    await control.wait(() => control.evaluate("!!document.querySelector('[aria-label=\"移除固定图片\"]')&&document.querySelectorAll('[role=option][data-result-code=\"image-stitch-img\"]').length===1"), "real App fixed-image token and original image candidate");
    await control.click('[role="option"][data-result-code="image-stitch-img"]');
    const document = await control.bindOriginalDocument("#image-list");
    const frame = await control.evaluate(`(()=>{const f=document.querySelector('iframe[title="Plugin"]');return {sandbox:f?.getAttribute('sandbox'),srcdocBytes:f?.getAttribute('srcdoc')?.length}})()`);
    assert.equal(frame.sandbox, "allow-scripts allow-popups"); assert.ok(frame.srcdocBytes > 1000);
    report.loader.push({ code: "image-stitch-img", ...frame, document: { contextId: document.contextId, sessionId: document.sessionId, frameId: document.frameId, nonce: document.nonce } });
    const state = await control.wait(async () => {
      const value = await document.read(imageState); return value.visible && value.imageCount === 1 ? value : null;
    }, "original image page decoding fixture pixels through img entry");
    assertOriginalImageCanvas(state); states[label] = state;
    assert.ok(report.nodeHost.opened.some(item => item.initialize.pid === state.nodeProcessPid), "Original page process proxy must reach its actual owned Node PID");
    assert.equal(state.bufferType, "function");
    report.checks.push("Real fixed-image intake and candidate reach original image-stitch img entry; 32×16 canvas and both independently fixed RGBA pixels match (" + label + ")");
    return document;
  }
  await control.click('.plugin-navigation [aria-label="返回搜索"]');
  await control.wait(() => control.evaluate("!!document.querySelector('[role=combobox]')"), "return to launcher before fixture image input");
  const document = await open("initial");
  await control.click("#btn-clear", document);
  states.cleared = await control.wait(async () => { const value = await document.read(imageState); return value.imageCount === 0 && !value.visible && value.placeholderVisible ? value : null; }, "original clear button empties image state");
  assert.ok(states.cleared.events.some(event => event.type === "pointerdown" && event.target === "btn-clear" && event.trusted === true));
  await control.click('.plugin-navigation [aria-label="返回搜索"]');
  await control.wait(() => control.evaluate("!!document.querySelector('[role=combobox]')"), "return to launcher after clearing original image");
  await open("reopened-recovery");
  await control.screenshot("image-recovered");
  report.scenarios.image = { status: "passed", states, boundary: "Faithful detected Node hint enters actual Panel Node preparation using fixture-preapproved session lookup and real current Node bootstrap/codec/nodeModuleBridge protocol. File/DataTransfer paste is an explicit synthetic input fixture; later business controls use trusted CDP. Rust permission UI/TaskRun, packaged runtime, original fs save function, OS clipboard, file picker, saving/copying/stash are not exercised." };
}
