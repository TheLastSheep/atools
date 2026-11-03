import assert from "node:assert/strict";

export const subnetExpected = {
  ordinary: { "网络地址": "192.168.1.0", "广播地址": "192.168.1.255", "子网掩码": "255.255.255.0", "通配符掩码": "0.0.0.255", CIDR: "/24",
    "首个可用主机": "192.168.1.1", "最后可用主机": "192.168.1.254", "可用主机数": "254", "总地址数": "256", "IP 类别": "C", "地址类型": "私有" },
  pointToPoint: { "网络地址": "10.0.0.0", "广播地址": "10.0.0.1", "子网掩码": "255.255.255.254", "通配符掩码": "0.0.0.1", CIDR: "/31",
    "首个可用主机": "10.0.0.0", "最后可用主机": "10.0.0.1", "可用主机数": "2", "总地址数": "2", "IP 类别": "A", "地址类型": "私有" },
  single: { "网络地址": "10.0.0.1", "广播地址": "10.0.0.1", "子网掩码": "255.255.255.255", "通配符掩码": "0.0.0.0", CIDR: "/32",
    "首个可用主机": "10.0.0.1", "最后可用主机": "10.0.0.1", "可用主机数": "1", "总地址数": "1", "IP 类别": "A", "地址类型": "私有" },
  reverse: { "所需主机": "30", "最小掩码": "255.255.255.224", CIDR: "/27", "网段总容量": "32", "可用主机数": "30",
    "推荐网段": "0.0.0.31 (通配符)", "指定起始IP": "192.168.1.100", "所在网段": "192.168.1.96/27", "网段范围": "192.168.1.97 ~ 192.168.1.126" },
};
export function assertExpectedRows(rows, expected) {
  assert.equal(rows.length, Object.keys(expected).length, "Every independently fixed original result row must exist");
  for (const [label, value] of Object.entries(expected)) assert.equal(rows.filter(item => item.label === label && item.value === value).length, 1,
    `Original result differs for ${label}=${value}`);
}
export const uuidCommand = "uuid5 dns example.com";
export const uuidExpected = "cfbff0d1-9375-5685-968c-48ce8b15ae17";
export function assertTrustedEvents(events, target, types) {
  for (const type of types) assert.ok(events.some(event => event.target === target && event.type === type && event.trusted === true),
    `Missing trusted ${type} on original control ${target}`);
  assert.ok(events.every(event => event.trusted === true), "This verifier must never synthesize untrusted control events");
}
const subnetState = `(()=>({ip:document.querySelector('#ipInput')?.value,mask:document.querySelector('#maskInput')?.value,
  hostCount:document.querySelector('#hostCountInput')?.value,startIp:document.querySelector('#startIpInput')?.value,
  reverse:!!document.querySelector('#reverseSection.active'),text:document.querySelector('#resultArea')?.textContent||'',
  rows:[...document.querySelectorAll('#resultArea .result-row')].map(r=>({label:r.querySelector('.result-label')?.textContent,value:r.querySelector('.result-value')?.textContent})),
  events:window.__originalBusinessBrowserObservation.events,focused:document.hasFocus(),visibility:document.visibilityState}))()`;
const uuidState = `(()=>({input:document.querySelector('#input')?.value,badge:document.querySelector('#badge')?.textContent?.trim(),
  meta:document.querySelector('#meta')?.textContent?.trim(),error:document.querySelector('#out .error')?.textContent?.trim()||'',
  selftestError:document.querySelector('#selftest-fail')?.textContent?.trim()||'',
  rows:[...document.querySelectorAll('#out .row:not(.action)')].map(r=>({label:r.querySelector('.label')?.textContent?.trim(),value:r.querySelector('.value')?.textContent?.trim()})),
  events:window.__originalBusinessBrowserObservation.events,visibility:document.visibilityState}))()`;

async function openOriginal(control, code, label, marker, report) {
  await control.type('[role="combobox"]', label);
  const selector = `[role="option"][data-result-code="${code}"]`;
  await control.wait(() => control.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length===1`), "original launcher result " + code);
  await control.click(selector);
  const document = await control.bindOriginalDocument(marker);
  const frame = await control.evaluate(`(()=>{const f=document.querySelector('iframe[title="Plugin"]');return {sandbox:f?.getAttribute('sandbox'),src:f?.getAttribute('src'),srcdocBytes:f?.getAttribute('srcdoc')?.length}})()`);
  assert.ok(frame.srcdocBytes > 1000 && frame.sandbox === "allow-scripts allow-popups", "Actual default PluginPanel loader and sandbox must remain selected");
  report.checks.push("Actual App launcher result activates complete original " + label + " through production PluginPanel loader");
  report.loader.push({ code, ...frame, document: { contextId: document.contextId, frameId: document.frameId, nonce: document.nonce } });
  return document;
}
export async function runSubnetBrowser(control, report) {
  report.phase = "subnet-open";
  const document = await openOriginal(control, "subnet", "子网", "#ipInput", report);
  const states = {};
  async function calculate(name, ip, mask, expected) {
    report.phase = "subnet-" + name;
    await control.type("#ipInput", ip, document); await control.type("#maskInput", mask, document);
    await control.click("#calcSection button", document);
    const state = await control.wait(async () => { const value = await document.read(subnetState); return value.rows.length === Object.keys(expected).length ? value : null; }, "subnet result " + name);
    assertExpectedRows(state.rows, expected); states[name] = state;
    report.checks.push("Original subnet " + name + " matches every independently fixed result row");
  }
  await calculate("ordinary-24", "192.168.1.100", "/24", subnetExpected.ordinary);
  await calculate("point-to-point-31", "10.0.0.1", "/31", subnetExpected.pointToPoint);
  await calculate("single-host-32", "10.0.0.1", "/32", subnetExpected.single);
  report.phase = "subnet-invalid-mask";
  await control.type("#maskInput", "255.0.255.0", document); await control.click("#calcSection button", document);
  states.invalidMask = await document.read(subnetState);
  assert.equal(states.invalidMask.text, "不是合法的子网掩码（连续1后接连续0）"); assert.equal(states.invalidMask.rows.length, 0);
  await calculate("mask-recovery", "192.168.1.100", "/24", subnetExpected.ordinary);
  await control.click(".tabs .tab:nth-child(2)", document);
  async function reverse(name, count) {
    report.phase = "subnet-" + name;
    await control.type("#hostCountInput", count, document); await control.type("#startIpInput", "192.168.1.100", document);
    await control.click("#reverseSection button", document);
    const state = await document.read(subnetState); states[name] = state; return state;
  }
  assertExpectedRows((await reverse("reverse-30", "30")).rows, subnetExpected.reverse);
  const rejected = await reverse("reverse-zero", "0"); assert.equal(rejected.rows.length, 0); assert.equal(rejected.text, "请输入有效的主机数量（1-16777216）");
  const recovered = await reverse("reverse-recovery", "30"); assertExpectedRows(recovered.rows, subnetExpected.reverse); assert.equal(recovered.reverse, true);
  for (const id of ["ipInput", "maskInput", "hostCountInput", "startIpInput"]) assertTrustedEvents(recovered.events, id, ["pointerdown", "keydown", "beforeinput", "input"]);
  report.checks.push("Original subnet invalid-mask and zero-host errors recover through trusted input and original buttons/tabs");
  report.scenarios.subnet = { status: "passed", states };
  await control.screenshot("subnet-recovered");
  await control.click('.plugin-navigation [aria-label="返回搜索"]');
  await control.wait(() => control.evaluate("!!document.querySelector('[role=combobox]')&&!document.querySelector('iframe[title=Plugin]')"), "actual return to launcher after subnet");
}
export async function runUuidBrowser(control, report) {
  report.phase = "uuid-open";
  const document = await openOriginal(control, "gen", "uuid", "#selftest-fail", report);
  const selector = '.plugin-navigation input.sub-input[aria-label="插件搜索"]';
  await control.wait(() => control.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length===1`), "UUID production host sub-input");
  async function command(text, accept, name) {
    report.phase = "uuid-" + name; await control.type(selector, text);
    return control.wait(async () => { const state = await document.read(uuidState); return !state.selftestError && state.input === text && accept(state) ? state : null; }, "original UUID " + name);
  }
  const correct = state => state.badge === "生成 UUIDv5（确定性）" && !state.error && state.meta.includes("dns") && state.meta.includes("example.com")
    && state.rows.some(row => row.label === "标准 UUID" && row.value === uuidExpected);
  const generated = await command(uuidCommand, correct, "deterministic-v5");
  const rejected = await command("not/valid!!", state => state.badge === "无法识别" && !!state.error, "invalid");
  const recovered = await command(uuidCommand, correct, "recovery"); assert.ok(recovered.rows.length >= 6);
  const hostEvents = await control.evaluate("window.fixture.events");
  assertTrustedEvents(hostEvents, "插件搜索", ["pointerdown", "keydown", "beforeinput", "input"]);
  assert.equal(hostEvents.some(event => event.target === "插件搜索" && event.type === "keydown" && event.key === "Enter"), false);
  assert.equal(recovered.events.some(event => event.type === "keydown" && event.key === "Enter"), false);
  report.checks.push("Actual host sub-input reaches original deterministic UUIDv5 DNS generator, rejects invalid input, and recovers without Enter or result/clipboard clicks");
  report.scenarios.uuid = { status: "passed", generated, rejected, recovered, hostEvents };
  await control.screenshot("uuid-recovered");
}
