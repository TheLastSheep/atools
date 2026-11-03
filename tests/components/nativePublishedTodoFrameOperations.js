// DOM events only for the pinned Todo release. No plugin services, reactive state or database writes.
(function () {
  var taskNames = ["ATools Todo synthetic alpha", "ATools Todo synthetic beta", "ATools Todo synthetic alpha edited"];
  var groupNames = ["待处理", "进行中", "未命名", "ATools synthetic group", "ATools renamed group"];
  function required(node, label) { if (!node) throw Error("Reviewed Todo DOM missing: " + label); return node; }
  function activeCaseId() {
    var caseId = window.__ATOOLS_PUBLISHED_ACTIVE_CASE__;
    return caseId === "todo-neo" || caseId === "converted-todo-neo-source" ? caseId : null;
  }
  function text(node) { return String(node && node.textContent || "").trim(); }
  function approved(value, values) {
    if (typeof value !== "string" || values.indexOf(value) < 0) throw Error("Unapproved synthetic Todo input");
    return value;
  }
  function input(selector, value) {
    var node = required(document.querySelector(selector), selector);
    var prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function key(node, name, type) {
    required(node, "keyboard target").dispatchEvent(new KeyboardEvent(type || "keydown", { key: name, bubbles: true, cancelable: true }));
  }
  function task(name) {
    approved(name, taskNames);
    return required(Array.from(document.querySelectorAll("article.task-card")).find(function (node) {
      return text(node.querySelector(".task-text")) === name;
    }), "task " + name);
  }
  function group(name) {
    approved(name, groupNames);
    return required(Array.from(document.querySelectorAll(".group-item")).find(function (node) {
      return text(node.querySelector(".group-title")) === name;
    }), "group " + name);
  }
  // The original BaseDrawer stays mounted while closed; its open class is the visible-state contract.
  function settings() { return document.querySelector('.drawer.open[aria-label="设置面板"]'); }
  function hideCompleted() {
    var drawer = settings();
    var label = drawer && Array.from(drawer.querySelectorAll("label")).find(function (node) {
      return text(node.querySelector("span")) === "隐藏已完成任务";
    });
    return label && label.querySelector('input[type="checkbox"]');
  }
  function state() {
    return {
      mainPage: !!document.querySelector(".app-shell .task-panel"),
      activeGroup: text(document.querySelector(".workspace-header h1")),
      groups: Array.from(document.querySelectorAll(".group-item")).map(function (node) {
        return { title: text(node.querySelector(".group-title")), active: node.classList.contains("active"),
          pendingCount: text(node.querySelector(".group-count")) };
      }),
      tasks: Array.from(document.querySelectorAll("article.task-card")).map(function (node) {
        var checkbox = node.querySelector('input[type="checkbox"]');
        return { text: text(node.querySelector(".task-text")), completed: !!checkbox && checkbox.checked,
          done: node.classList.contains("done"), active: node.classList.contains("active") };
      }),
      creating: !!document.querySelector("textarea.task-create-input"),
      createText: document.querySelector("textarea.task-create-input")?.value || "",
      editing: !!document.querySelector("textarea.task-edit-input"),
      editText: document.querySelector("textarea.task-edit-input")?.value || "",
      creatingGroup: !!document.querySelector("input.group-create-input"),
      groupText: document.querySelector("input.group-create-input")?.value || "",
      editingGroup: !!document.querySelector("input.group-edit"),
      groupEditText: document.querySelector("input.group-edit")?.value || "",
      settingsOpen: !!settings(), hideCompleted: !!hideCompleted() && hideCompleted().checked,
      searchOpen: !!document.querySelector('.search-picker[aria-label="搜索待办"]'),
      searchQuery: document.querySelector("input.task-search-input")?.value || "",
      searchResults: Array.from(document.querySelectorAll(".search-result")).map(function (node) {
        return { text: text(node.querySelector(".result-text")), group: text(node.querySelector(".result-group")) };
      }),
      searchEmpty: text(document.querySelector(".search-empty")),
      disabledWindowControls: document.querySelectorAll('[title="固定便签"],[title="番茄钟"]').length
    };
  }
  function perform(operation, data) {
    if (!activeCaseId()) throw Error("Unapproved Todo fixture case");
    data = data || {};
    if (operation === "new-task") required(document.querySelector('.workspace-header button[title="新建任务"]'), "new task button").click();
    else if (operation === "set-task") input("textarea.task-create-input", approved(data.value, taskNames));
    else if (operation === "commit-task") key(document.querySelector("textarea.task-create-input"), "Enter");
    else if (operation === "edit-task") task(data.text).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    else if (operation === "set-edit") input("textarea.task-edit-input", approved(data.value, taskNames));
    else if (operation === "commit-edit") key(document.querySelector("textarea.task-edit-input"), "Enter");
    else if (operation === "toggle-task") required(task(data.text).querySelector('input[type="checkbox"]'), "task checkbox").click();
    else if (operation === "open-search") {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      key(document.body, "/");
    } else if (operation === "set-search") input("input.task-search-input", approved(data.value, ["alpha", "ATools Todo synthetic absent"]));
    else if (operation === "close-search") key(document.querySelector("input.task-search-input"), "Escape");
    else if (operation === "open-settings") required(document.querySelector('button.sidebar-settings-button[title="设置"]'), "settings button").click();
    else if (operation === "close-settings") required(settings() && settings().querySelector("button.drawer-close"), "settings close").click();
    else if (operation === "toggle-hide-completed") required(hideCompleted(), "hide completed checkbox").click();
    else if (operation === "new-group") required(document.querySelector("button.add-group-button"), "add group").click();
    else if (operation === "set-group") input("input.group-create-input", approved(data.value, groupNames.slice(3)));
    else if (operation === "commit-group") required(document.querySelector("form.inline-group-composer"), "group composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    else if (operation === "select-group") group(data.title).click();
    else if (operation === "edit-group") group(data.title).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
    else if (operation === "choose-group-edit") required(Array.from(document.querySelectorAll(".context-menu button")).find(function (node) {
      return text(node) === "编辑";
    }), "group edit menu item").click();
    else if (operation === "set-group-edit") input("input.group-edit", approved(data.value, groupNames.slice(3)));
    else if (operation === "commit-group-edit") key(document.querySelector("input.group-edit"), "Enter", "keyup");
    else throw Error("Unknown reviewed Todo operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { get caseId() { return activeCaseId(); }, state: state, perform: perform };
})();
