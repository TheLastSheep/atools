import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativePublishedTimestampFrameOperations.js?raw";

type Adapter = { caseId: string; state: () => Record<string, unknown>; perform: (operation: string, data?: Record<string, unknown>) => unknown };
let adapter: Adapter;

beforeEach(() => {
  // Hand-authored synthetic DOM only. Original published plugin code is never loaded by these tests.
  document.body.innerHTML = `<div class="unit-group"><button class="unit-btn active">秒</button><button class="unit-btn">毫秒</button><button class="unit-btn">纳秒</button></div>
    <select class="tz-select"><option value="0">UTC+08:00 | 北京</option><option value="12">UTC+00:00 | 伦敦</option></select>
    <div class="section"><div class="input-with-icon"><input readonly placeholder="请选择日期" value="2024-01-02 03:04:05"></div><div class="result-value"><span class="result-text">1704164645</span><button class="copy-btn">copy</button></div></div>
    <div class="section"><input placeholder="请输入时间戳"><div class="multi-result"><div class="multi-result-item"><span class="result-text">2024-01-02 03:04:05</span><button class="copy-btn">copy</button></div></div></div>
    <span class="current-ts-value">1704164645000</span><button class="pause-btn">暂停</button><button class="reset-btn">重置数据</button>
    <div class="picker-popup"><span class="cal-title">2024-01</span><button class="cal-nav-btn" title="上一年">«</button><button class="cal-nav-btn" title="下一年">»</button><button class="cal-nav-btn" title="上个月">‹</button><button class="cal-nav-btn" title="下个月">›</button>
    <button class="cal-day other-month">2</button><button class="cal-day selected">2</button>
    <div class="time-column"><button class="time-item selected">03</button></div><div class="time-column"><button class="time-item selected">04</button></div><div class="time-column"><button class="time-item selected">05</button></div><button class="confirm-btn">确定</button></div>`;
  window.eval(source);
  adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});

it("reads separate forward/reverse DOM results without clicking copy surfaces", () => {
  const copy = vi.fn();
  document.querySelectorAll(".copy-btn,.multi-result-item,.current-ts-value").forEach(node => node.addEventListener("click", copy));
  expect(adapter.caseId).toBe("com-ztools-timestamp");
  expect(adapter.state()).toMatchObject({ input: "", activeUnit: "秒", timezoneOptionCount: 2,
    dateResults: ["2024-01-02 03:04:05"], reverseDate: "2024-01-02 03:04:05", reverseTimestamp: "1704164645",
    pickerSelectedTime: ["03", "04", "05"] });
  expect(copy).not.toHaveBeenCalled();
});

it("drives the real input/change event surfaces and does not write the readonly reverse field", () => {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="请输入时间戳"]')!;
  const events = vi.fn(); input.addEventListener("input", events);
  adapter.perform("set-timestamp", { value: "1704164645000" });
  expect(input.value).toBe("1704164645000"); expect(events).toHaveBeenCalledOnce();
  expect((events.mock.calls[0][0] as Event).bubbles).toBe(true);
  const select = document.querySelector<HTMLSelectElement>(".tz-select")!;
  const changed = vi.fn(); select.addEventListener("change", changed);
  adapter.perform("select-london");
  expect(select.value).toBe("12"); expect(changed).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLInputElement>("input[readonly]")!.value).toBe("2024-01-02 03:04:05");
});

it("clicks only the reviewed unit, current-month day and selected time buttons", () => {
  const second = vi.fn(), millis = vi.fn(), otherMonth = vi.fn(), currentMonth = vi.fn(), minute = vi.fn();
  document.querySelectorAll(".unit-btn")[0].addEventListener("click", second);
  document.querySelectorAll(".unit-btn")[1].addEventListener("click", millis);
  document.querySelector(".cal-day.other-month")!.addEventListener("click", otherMonth);
  document.querySelector(".cal-day.selected")!.addEventListener("click", currentMonth);
  document.querySelectorAll(".time-column")[1].querySelector("button")!.addEventListener("click", minute);
  adapter.perform("select-unit", { unit: "millisecond" }); adapter.perform("picker-day", { day: 2 });
  adapter.perform("picker-time", { part: "minute", value: 4 });
  expect(millis).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  expect(currentMonth).toHaveBeenCalledOnce(); expect(otherMonth).not.toHaveBeenCalled(); expect(minute).toHaveBeenCalledOnce();
});

it("uses calendar navigation titles and explicit pause/confirm controls", () => {
  const previousYear = vi.fn(), nextMonth = vi.fn(), pause = vi.fn(), confirm = vi.fn();
  document.querySelector('[title="上一年"]')!.addEventListener("click", previousYear);
  document.querySelector('[title="下个月"]')!.addEventListener("click", nextMonth);
  document.querySelector(".pause-btn")!.addEventListener("click", pause);
  document.querySelector(".confirm-btn")!.addEventListener("click", confirm);
  adapter.perform("picker-year", { direction: "previous" }); adapter.perform("picker-month", { direction: "next" });
  adapter.perform("toggle-pause"); adapter.perform("confirm-date-picker");
  expect(previousYear).toHaveBeenCalledOnce(); expect(nextMonth).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
});

it.each([
  ["set-timestamp", { value: "x".repeat(65) }], ["set-timestamp", { value: "0\n" }],
  ["select-unit", { unit: "__proto__" }], ["picker-time", { part: "hour", value: 24 }],
  ["picker-time", { part: "__proto__", value: 0 }], ["picker-day", { day: 0 }],
  ["picker-year", { direction: "arbitrary" }], ["copy-result", {}]
])("rejects unapproved adapter operation/arguments %s", (operation, data) => {
  expect(() => adapter.perform(operation as string, data as Record<string, unknown>)).toThrow();
});
