// Fixed visible-UI operations for the future converted Tetris source case.
(function () {
  var CASE_ID = "converted-tetris-source";
  var OPERATIONS = ["start-game", "move-left", "pause", "resume", "settings-from-pause", "set-theme-retro", "set-theme-modern", "settings-return"];
  function visible(node) {
    if (!node || node.disabled || node.closest("[hidden],[inert]")) return false;
    for (var current = node; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function unique(nodes, label) {
    var list = Array.from(nodes).filter(visible);
    if (list.length !== 1) throw Error("Tetris visible control missing or ambiguous: " + label);
    return list[0];
  }
  function button(scope, label) {
    return unique(Array.from(scope.querySelectorAll("button")).filter(function (node) {
      return node.textContent.trim() === label;
    }), label);
  }
  function screen() {
    var screens = ["home", "settings", "game"].filter(function (name) {
      var node = document.querySelector(name === "home" ? "#homeScreen" : name === "settings" ? "#settingsScreen" : "#gameScreen");
      return visible(node);
    });
    return screens.length === 1 ? screens[0] : "invalid";
  }
  function canvasSignature() {
    var canvas = unique(document.querySelectorAll("#gameScreen .game-board canvas"), "game board canvas");
    if (!canvas.width || !canvas.height || canvas.width * canvas.height > 16000000) throw Error("Tetris canvas dimensions are invalid");
    var context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("Tetris canvas pixels are unavailable");
    var pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    var hash = 2166136261;
    for (var i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
    return { width: canvas.width, height: canvas.height, pixelHash: hash.toString(16).padStart(8, "0") };
  }
  function state() {
    var pause = document.querySelector("#pauseOverlay");
    var theme = ["neon", "modern", "retro"].find(function (name) { return document.body.classList.contains("theme-" + name); }) || "unknown";
    var board = null;
    if (screen() === "game") {
      try { board = canvasSignature(); } catch (_) { board = null; }
    }
    return {
      ready: screen() !== "invalid", screen: screen(), paused: visible(pause) && pause.classList.contains("show"),
      gameOver: visible(document.querySelector("#gameOver")) && document.querySelector("#gameOver").classList.contains("show"), score: document.querySelector("#gameScreen .score-value")?.textContent.trim() || "",
      theme: theme, persistedTheme: localStorage.getItem("tetrisTheme"), board: board
    };
  }
  function approved(data, operation) {
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === keys.length
      && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === CASE_ID && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function waitFor(predicate, label) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + 1800;
      function check() {
        try { var value = predicate(); if (value) { resolve(value); return; } }
        catch (error) { reject(error); return; }
        if (Date.now() >= deadline) { reject(Error("Tetris UI state did not change: " + label)); return; }
        setTimeout(check, 16);
      }
      check();
    });
  }
  function perform(operation, data) {
    if (window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ !== CASE_ID || OPERATIONS.indexOf(operation) < 0 || !approved(data, operation)) {
      throw Error("Unapproved Tetris UI operation");
    }
    if (operation === "start-game") {
      if (screen() !== "home") throw Error("Tetris start requires the visible home screen");
      button(document.querySelector("#homeScreen"), "开始游戏").click();
      return waitFor(function () { return screen() === "game" ? state() : null; }, "game start");
    }
    if (operation === "move-left") {
      if (screen() !== "game" || document.querySelector("#pauseOverlay.show") || document.querySelector("#gameOver.show")) {
        throw Error("Tetris move requires an active game");
      }
      var before = canvasSignature();
      var leftControl = unique(Array.from(document.querySelectorAll("#gameScreen .control-item")).filter(function (node) { return node.textContent.split(":").slice(1).join(":").trim() === "移动"; }), "left-move control display");
      var label = leftControl.textContent.split(":")[0].trim();
      var key = label === "←" ? "ArrowLeft" : label.length === 1 ? label.toLowerCase() : "";
      if (!key) throw Error("Visible left-move binding is unsupported");
      var event = new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      var after = canvasSignature();
      if (!event.defaultPrevented || before.pixelHash === after.pixelHash) throw Error("Tetris left move produced no visible board change");
      return Object.assign(state(), { boardTransition: { beforeHash: before.pixelHash, afterHash: after.pixelHash } });
    }
    if (operation === "pause") {
      if (screen() !== "game" || document.querySelector("#pauseOverlay.show")) throw Error("Tetris pause requires a running game");
      button(document.querySelector("#gameScreen"), "暂停").click();
      return waitFor(function () { return document.querySelector("#pauseOverlay.show") ? state() : null; }, "pause");
    }
    if (operation === "resume") {
      if (screen() !== "game" || !document.querySelector("#pauseOverlay.show")) throw Error("Tetris resume requires the pause overlay");
      button(document.querySelector("#pauseOverlay"), "继续游戏").click();
      return waitFor(function () { return !document.querySelector("#pauseOverlay.show") ? state() : null; }, "resume");
    }
    if (operation === "settings-from-pause") {
      if (screen() !== "game" || !document.querySelector("#pauseOverlay.show")) throw Error("Tetris settings requires a paused game");
      button(document.querySelector("#pauseOverlay"), "进入设置").click();
      return waitFor(function () { return screen() === "settings" ? state() : null; }, "settings navigation");
    }
    if (operation === "set-theme-retro" || operation === "set-theme-modern") {
      if (screen() !== "settings") throw Error("Tetris theme selection requires settings");
      var target = operation === "set-theme-retro" ? "retro" : "modern";
      var title = target === "retro" ? "复古像素" : "现代极简";
      var card = unique(Array.from(document.querySelectorAll("#settingsScreen .theme-card")).filter(function (node) {
        return node.querySelector(".theme-card-info h4")?.textContent.trim() === title;
      }), target + " theme card");
      if (state().theme === target && localStorage.getItem("tetrisTheme") === target) throw Error("Tetris theme choice would not change the persisted setting");
      card.click();
      return waitFor(function () {
        return document.body.classList.contains("theme-" + target) && card.classList.contains("active")
          && localStorage.getItem("tetrisTheme") === target ? state() : null;
      }, "persisted theme change");
    }
    if (operation === "settings-return") {
      if (screen() !== "settings") throw Error("Tetris settings return requires settings");
      button(document.querySelector("#settingsScreen"), "← 返回").click();
      return waitFor(function () { return screen() === "game" ? state() : null; }, "return to paused game");
    }
    throw Error("Unreviewed Tetris operation");
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    get caseId() { return window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ === CASE_ID ? CASE_ID : null; },
    state: state, perform: perform
  };
})();
