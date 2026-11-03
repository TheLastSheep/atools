// Explicit fixture DOM operations for the SHA-pinned color-helper package only.
(function () {
  function inputForModel(model) {
    var labels = { hex: "HEX", rgb: "RGB", hsl: "HSL" };
    if (!Object.prototype.hasOwnProperty.call(labels, model)) throw Error("Unreviewed color model");
    return Array.from(document.querySelectorAll(".color-value input")).find(function (input) {
      return input.parentElement && input.parentElement.previousElementSibling
        && input.parentElement.previousElementSibling.textContent.trim() === labels[model];
    });
  }
  function setInput(node, value) {
    if (!node || typeof value !== "string" || value.length > 64) throw Error("Reviewed color input missing or out of bounds");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function dialogInput(label) {
    var dialog = document.querySelector('[role="dialog"]');
    var node = dialog && Array.from(dialog.querySelectorAll("label")).find(function (item) {
      return item.textContent.trim() === label;
    });
    return node && document.getElementById(node.htmlFor);
  }
  function state() {
    var content = document.querySelector(".color-content");
    return {
      colorPage: !!content,
      hex: inputForModel("hex") && inputForModel("hex").value || "",
      rgb: inputForModel("rgb") && inputForModel("rgb").value || "",
      hsl: inputForModel("hsl") && inputForModel("hsl").value || "",
      background: content && getComputedStyle(content).backgroundColor || "",
      selectedNav: Array.from(document.querySelectorAll(".app-nav [role='button']")).filter(function (node) {
        return node.classList.contains("Mui-selected");
      }).map(function (node) { return node.textContent.trim(); }),
      collectionPage: !!document.querySelector(".collect-body"),
      collectionRows: Array.from(document.querySelectorAll(".collect-item-info")).map(function (node) { return node.textContent.trim(); }),
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      dialogError: document.querySelector('.collect-form-content [role="alert"]')?.textContent.trim() || "",
      gradientPage: !!document.querySelector(".gradient-body"),
      gradientRows: document.querySelectorAll(".gradient-item").length,
      gradientBackground: document.querySelector(".gradient-item > div")?.style.background || ""
    };
  }
  function perform(operation, data) {
    if (operation === "set-color") setInput(inputForModel(data.model), data.value);
    else if (operation === "navigate") {
      var titles = { color: "颜色", collect: "收藏颜色", gradient: "渐变色" };
      if (!Object.prototype.hasOwnProperty.call(titles, data.page)) throw Error("Unreviewed color navigation");
      var nav = Array.from(document.querySelectorAll(".app-nav [role='button']")).find(function (node) {
        return node.textContent.trim() === titles[data.page];
      });
      if (!nav) throw Error("Published color navigation missing");
      nav.click();
    } else if (operation === "new-collection") {
      var button = document.querySelector(".collect-btn-add");
      if (!button) throw Error("Published new collection button missing");
      button.click();
    } else if (operation === "set-collection-name") setInput(dialogInput("名称"), data.value);
    else if (operation === "set-collection-color") setInput(dialogInput("色值"), data.value);
    else if (operation === "confirm-collection") {
      var dialog = document.querySelector('[role="dialog"]');
      var confirm = dialog && Array.from(dialog.querySelectorAll("button")).find(function (button) {
        return button.textContent.trim() === "确定";
      });
      if (!confirm) throw Error("Published collection confirmation missing");
      confirm.click();
    } else throw Error("Unknown reviewed color operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "color-helper", state: state, perform: perform };
})();
