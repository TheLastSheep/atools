// DOM-only operations for the reviewed, unmodified com-ztools-timestamp release.
(function () {
  function reverseSection() {
    return Array.from(document.querySelectorAll(".section")).find(function (node) {
      return !!node.querySelector(".input-with-icon");
    });
  }
  function timestampInput() { return document.querySelector('input[placeholder="请输入时间戳"]'); }
  function state() {
    var input = timestampInput(), reverse = reverseSection(), picker = document.querySelector(".picker-popup");
    return {
      hasTimestampInput: !!input, input: input && input.value || "",
      activeUnit: Array.from(document.querySelectorAll(".unit-btn")).filter(function (node) {
        return node.classList.contains("active");
      }).map(function (node) { return String(node.textContent || "").trim(); })[0] || "",
      timezone: document.querySelector(".tz-select") && document.querySelector(".tz-select").selectedOptions[0].textContent || "",
      timezoneOptionCount: document.querySelectorAll(".tz-select option").length,
      dateResults: Array.from(document.querySelectorAll(".multi-result .result-text")).map(function (node) { return node.textContent || ""; }),
      inputError: !!input && input.classList.contains("input-error"),
      invalidMessage: document.querySelector(".result-placeholder") && document.querySelector(".result-placeholder").textContent || "",
      detectHint: document.querySelector(".detect-hint") && document.querySelector(".detect-hint").textContent.trim() || "",
      reverseDate: reverse && reverse.querySelector("input") && reverse.querySelector("input").value || "",
      reverseTimestamp: reverse && reverse.querySelector(".result-text") && reverse.querySelector(".result-text").textContent || "",
      currentTimestamp: document.querySelector(".current-ts-value") && document.querySelector(".current-ts-value").textContent || "",
      paused: !!document.querySelector(".pause-btn.paused"),
      pickerOpen: !!picker,
      pickerMonth: picker && picker.querySelector(".cal-title") && picker.querySelector(".cal-title").textContent || "",
      pickerSelectedDay: picker && picker.querySelector(".cal-day.selected") && picker.querySelector(".cal-day.selected").textContent || "",
      pickerSelectedTime: picker ? Array.from(picker.querySelectorAll(".time-column .time-item.selected")).map(function (node) {
        return node.textContent || "";
      }) : []
    };
  }
  function requireNode(node, label) { if (!node) throw Error("Reviewed timestamp DOM missing: " + label); return node; }
  function click(node, label) { requireNode(node, label).click(); return state(); }
  function perform(operation, data) {
    if (operation === "select-london") {
      var select = requireNode(document.querySelector(".tz-select"), "timezone select");
      var option = requireNode(Array.from(select.options).find(function (item) {
        return String(item.textContent || "").trim() === "UTC+00:00 | 伦敦";
      }), "London option");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true })); return state();
    }
    if (operation === "select-unit") {
      var labels = { second: "秒", millisecond: "毫秒", nanosecond: "纳秒" };
      if (!Object.prototype.hasOwnProperty.call(labels, data.unit)) throw Error("Unapproved timestamp unit");
      return click(Array.from(document.querySelectorAll(".unit-btn")).find(function (node) {
        return String(node.textContent || "").trim() === labels[data.unit];
      }), "unit button");
    }
    if (operation === "set-timestamp") {
      if (typeof data.value !== "string" || data.value.length > 64 || /[\u0000-\u001f\u007f]/.test(data.value)) throw Error("Unapproved finite timestamp input");
      var input = requireNode(timestampInput(), "timestamp input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, data.value);
      input.dispatchEvent(new Event("input", { bubbles: true })); return state();
    }
    if (operation === "open-date-picker") return click(reverseSection() && reverseSection().querySelector(".input-with-icon"), "date picker entry");
    if (operation === "picker-year" || operation === "picker-month") {
      if (data.direction !== "previous" && data.direction !== "next") throw Error("Unapproved calendar direction");
      var title = operation === "picker-year" ? (data.direction === "previous" ? "上一年" : "下一年")
        : (data.direction === "previous" ? "上个月" : "下个月");
      return click(document.querySelector('.picker-popup .cal-nav-btn[title="' + title + '"]'), "calendar navigation");
    }
    if (operation === "picker-day") {
      if (!Number.isInteger(data.day) || data.day < 1 || data.day > 31) throw Error("Unapproved calendar day");
      return click(Array.from(document.querySelectorAll(".picker-popup .cal-day:not(.other-month)")).find(function (node) {
        return String(node.textContent || "").trim() === String(data.day);
      }), "current-month day");
    }
    if (operation === "picker-time") {
      var indexes = { hour: 0, minute: 1, second: 2 };
      if (!Object.prototype.hasOwnProperty.call(indexes, data.part) || !Number.isInteger(data.value)
        || data.value < 0 || data.value > (data.part === "hour" ? 23 : 59)) throw Error("Unapproved clock picker value");
      var column = requireNode(document.querySelectorAll(".picker-popup .time-column")[indexes[data.part]], "time column");
      return click(Array.from(column.querySelectorAll(".time-item")).find(function (node) {
        return String(node.textContent || "").trim() === String(data.value).padStart(2, "0");
      }), "time picker item");
    }
    if (operation === "confirm-date-picker") return click(document.querySelector(".picker-popup .confirm-btn"), "picker confirm");
    if (operation === "toggle-pause") return click(document.querySelector(".pause-btn"), "pause/resume");
    if (operation === "reset-data") return click(document.querySelector(".reset-btn"), "reset data");
    throw Error("Unknown timestamp fixture operation");
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "com-ztools-timestamp", state: state, perform: perform };
})();
