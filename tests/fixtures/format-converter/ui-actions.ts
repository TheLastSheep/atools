import assert from "node:assert/strict";
import type { attachLiveMarkdownPage } from "../live-markdown/page-fixture";

type Controls = ReturnType<typeof attachLiveMarkdownPage>;
type JobState = "succeeded" | "partial" | "failed";

const jobLabels: Record<JobState, string> = { succeeded: "转换完成", partial: "部分完成", failed: "转换失败" };

export async function waitForFormatConverterMount(controls: Controls, initialName: string) {
  await controls.wait("!!document.querySelector('#root .app-shell')", "original Format Converter React UI mount");
  await waitForSelectedNames(controls, [initialName], "initial files-entry payload");
  await controls.wait("!!document.querySelector('.runtime-strip')", "original runtime status UI");
  return controls.evaluate("document.querySelector('.runtime-strip')?.innerText || ''");
}

export async function selectTargetThroughUi(controls: Controls, target: "纯文本" | "JSON" | "CSV") {
  await controls.clickText(".target-options button", target);
  await controls.wait(`Array.from(document.querySelectorAll('.target-options button.active span')).some(e=>e.innerText.trim()===${JSON.stringify(target)})`,
    `original target selection ${target}`);
}

export async function selectOutputDirectoryThroughUi(controls: Controls, path: string) {
  await controls.click(".directory-card");
  await controls.wait(`document.querySelector('.directory-card.selected')?.innerText.includes(${JSON.stringify(path)})`,
    "original output-directory picker result");
}

export async function chooseInputsThroughUi(controls: Controls, names: string[]) {
  await openInputPickerThroughUi(controls);
  await waitForSelectedNames(controls, names, `original file picker selection ${names.join(", ")}`);
  await controls.wait("!document.querySelector('.drop-zone .spin') && !document.querySelector('.error-banner')",
    `original file picker accepted ${names.join(", ")}`, 15_000);
}

export async function openInputPickerThroughUi(controls: Controls) {
  await controls.click(".drop-zone");
}

export async function assertEmptyFileErrorThroughUi(controls: Controls, filename: string) {
  await controls.wait(`!!document.querySelector('.error-banner')?.innerText.includes(${JSON.stringify(filename)})`,
    `visible empty-file error for ${filename}`);
  const message = await controls.evaluate("document.querySelector('.error-banner')?.innerText.trim() || ''");
  assert.match(message, /文件大小不在允许范围内/u);
  return message;
}

export async function waitForPlanReady(controls: Controls) {
  await controls.wait("!!document.querySelector('.plan-card.ready') && !!document.querySelector('.primary-action') && !document.querySelector('.primary-action').disabled",
    "original conversion plan to become executable", 15_000);
  return controls.evaluate("document.querySelector('.plan-card')?.innerText || ''");
}

export async function startConversionThroughUi(controls: Controls, expected: JobState) {
  await waitForPlanReady(controls);
  await controls.click(".primary-action");
  await waitForJobStatus(controls, expected);
  return readJobUi(controls);
}

export async function waitForJobStatus(controls: Controls, state: JobState) {
  const label = jobLabels[state];
  await controls.wait(`document.querySelector('.job-header h2')?.innerText.trim()===${JSON.stringify(label)}`,
    `original job state ${label}`, 30_000);
}

export async function assertPartialJobContains(controls: Controls, filename: string) {
  const job = await readJobUi(controls);
  assert.equal(job.status, jobLabels.partial);
  assert.ok(job.text.includes(filename), `Original partial job UI must identify ${filename}`);
  assert.ok(job.text.includes("重试失败项"), "Original partial job UI must expose its retry action");
  assert.match(job.displayedJobId, /^[a-f0-9]{8}$/u, "Original UI must expose its displayed first 8 job-id characters");
  const failedItem = job.items.find((item: { className: string; text: string }) =>
    item.className.split(/\s+/u).includes("failed") && item.text.includes(filename));
  assert.ok(failedItem, `Original partial job UI must mark ${filename} failed`);
  await controls.evaluate(`(()=>{const error=document.querySelector('.job-item.failed em');error?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});return true})()`);
  const visibleError = await controls.evaluate(`(()=>{const element=document.querySelector('.job-item.failed em');if(!element)return null;
    const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return {text:element.innerText.trim(),
    display:style.display,visibility:style.visibility,opacity:Number(style.opacity),left:rect.left,top:rect.top,right:rect.right,
    bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`);
  assert.ok(visibleError, "Original partial job error element must exist in the DOM");
  assert.ok(visibleError.text.length > 0, "Original partial job error element must contain visible error text");
  assert.notEqual(visibleError.display, "none", "Original partial job error must not use display:none");
  assert.notEqual(visibleError.visibility, "hidden", "Original partial job error must not use visibility:hidden");
  assert.ok(visibleError.opacity > 0, "Original partial job error must have nonzero opacity");
  assert.ok(visibleError.width > 0 && visibleError.height > 0, "Original partial job error must have a nonzero box");
  assert.ok(visibleError.right > 0 && visibleError.left < visibleError.viewportWidth
    && visibleError.bottom > 0 && visibleError.top < visibleError.viewportHeight,
  "Original partial job error must intersect the current viewport before screenshot capture");
  const visibleErrors = await controls.evaluate(`Array.from(document.querySelectorAll('.job-item.failed em')).map(e=>e.innerText.trim()).filter(Boolean)`);
  assert.ok(visibleErrors.length > 0, "Original partial job UI must render the conversion error text");
  return { ...job, visibleErrors };
}

export async function retryFailedItemsThroughUi(controls: Controls) {
  await controls.clickText(".job-actions button", "重试失败项");
  await waitForJobStatus(controls, "succeeded");
  return readJobUi(controls);
}

export async function readJobUi(controls: Controls) {
  const job = await controls.evaluate(`(()=>{const root=document.querySelector('.job-drawer');return root?{
    text:root.innerText,
    status:root.querySelector('.job-header h2')?.innerText.trim()||'',
    displayedJobId:(root.querySelector('.job-header span')?.innerText.trim().split('·').at(-1)||'').trim(),
    items:Array.from(root.querySelectorAll('.job-item')).map(item=>({className:item.className,text:item.innerText.trim()}))
  }:null})()`);
  assert.ok(job, "Original Format Converter job drawer is visible");
  return job;
}

async function waitForSelectedNames(controls: Controls, names: string[], label: string) {
  const expected = JSON.stringify(names);
  await controls.wait(`JSON.stringify(Array.from(document.querySelectorAll('.file-row strong')).map(e=>e.innerText.trim()))===${JSON.stringify(expected)}`,
    label, 15_000);
  const actual = await controls.evaluate("Array.from(document.querySelectorAll('.file-row strong')).map(e=>e.innerText.trim())");
  assert.deepEqual(actual, names, `Original Format Converter UI must show exact selected input names for ${label}`);
  return actual as string[];
}
