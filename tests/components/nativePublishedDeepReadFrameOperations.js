// A narrow DOM adapter for the fixed converted DeepRead release. It never writes plugin storage.
(function () {
  var CASE_ID = "converted-deepread-source";
  var BOOK_TITLE = "ATools DeepRead Reader Fixture";
  var SEARCH_TEXT = "DeepRead fixed reading line 020";
  var DISCLAIMER_TEXT = "同意并继续使用";
  var MENU_WAIT_MS = 160;
  var MENU_POLL_MS = 12;
  function activeCaseId() {
    return window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ === CASE_ID ? CASE_ID : null;
  }
  function required(node, label) {
    if (!node) throw Error("Reviewed DeepRead DOM missing: " + label);
    return node;
  }
  function text(node) { return String(node && node.textContent || "").trim(); }
  function fixtureCard() {
    return required(Array.from(document.querySelectorAll("article.book-card")).find(function (card) {
      return text(card.querySelector("h3, .book-title, .book-title-text")) === BOOK_TITLE;
    }), "fixed local book card");
  }
  function searchDialog() { return document.querySelector('section[aria-labelledby="book-search-title"]'); }
  function fixedSearchResults() {
    var dialog = searchDialog();
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll(".search-list.book-search-list button")).filter(function (button) {
      return text(button.querySelector("span")).includes(SEARCH_TEXT);
    });
  }
  function menuFailure(stage) {
    var menus = document.querySelectorAll(".context-menu");
    var buttons = document.querySelectorAll(".context-menu button");
    var matches = Array.from(buttons).filter(function (button) { return text(button) === "搜索跳转"; });
    return Error("DeepRead menu probe failed;stage=" + stage
      + ";menuCount=" + Math.min(menus.length, 2)
      + ";buttonCount=" + Math.min(buttons.length, 4)
      + ";actionCount=" + Math.min(matches.length, 2));
  }
  async function waitForSearchAction(deadline) {
    while (true) {
      if (activeCaseId() !== CASE_ID) throw menuFailure("case-changed");
      var menus = document.querySelectorAll(".context-menu");
      var buttons = Array.from(document.querySelectorAll(".context-menu button"));
      var matches = buttons.filter(function (button) { return text(button) === "搜索跳转"; });
      if (performance.now() >= deadline) throw menuFailure("render-timeout");
      if (menus.length > 1 || matches.length > 1) throw menuFailure("ambiguous-action");
      if (menus.length === 1 && matches.length === 1) return matches[0];
      await Promise.resolve();
      await new Promise(function (resolve) { setTimeout(resolve, MENU_POLL_MS); });
    }
  }
  function state() {
    var dialog = searchDialog();
    var input = dialog && dialog.querySelector("input");
    var card = Array.from(document.querySelectorAll("article.book-card")).find(function (item) {
      return text(item.querySelector("h3, .book-title, .book-title-text")) === BOOK_TITLE;
    });
    var progress = card && card.querySelector(".progress-track > span");
    var nodeVersion = window.process && window.process.versions && window.process.versions.node;
    return {
      caseId: activeCaseId(), mainLibraryVisible: !!document.querySelector("article.book-card"),
      firstUseDisclaimerVisible: !!document.querySelector('.disclaimer-dialog[role="alertdialog"]'),
      emptyLibraryVisible: Array.from(document.querySelectorAll(".empty-state strong")).some(function (node) {
        return text(node) === "书架空空如也";
      }),
      fixtureBookVisible: !!card, fixtureBookActive: !!card && card.classList.contains("active"),
      progressIndicatorWidth: progress && progress.style.width || null,
      nodeVersion: typeof nodeVersion === "string" && nodeVersion.length <= 32 ? nodeVersion : null,
      searchOpen: !!dialog, searchQuery: input && input.value || "",
      searchResultCount: dialog ? dialog.querySelectorAll(".search-list.book-search-list button").length : 0,
      fixedSearchResultCount: fixedSearchResults().length
    };
  }
  function perform(operation) {
    if (!activeCaseId()) throw Error("Unapproved DeepRead fixture case");
    if (operation === "accept-first-use-disclaimer") {
      var dialog = required(document.querySelector('.disclaimer-dialog[role="alertdialog"][aria-modal="true"]'), "original first-use disclaimer");
      var button = required(dialog.querySelector("button.disclaimer-accept-button"), "original disclaimer consent button");
      if (text(button) !== DISCLAIMER_TEXT || button.disabled) throw Error("Original DeepRead consent control did not match its fixed label");
      button.click();
    } else if (operation === "select-fixture-book") fixtureCard().click();
    else if (operation === "open-search-jump") {
      var card = fixtureCard();
      var deadline = performance.now() + MENU_WAIT_MS;
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 24, clientY: 24 }));
      return waitForSearchAction(deadline).then(function (action) {
        if (performance.now() >= deadline) throw menuFailure("render-timeout");
        if (activeCaseId() !== CASE_ID || !action.isConnected) throw menuFailure("stale-action");
        action.click();
        return state();
      });
    } else if (operation === "set-fixed-search") {
      var input = required(searchDialog() && searchDialog().querySelector("input"), "original book search input");
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, SEARCH_TEXT);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (operation === "jump-to-fixed-match") {
      var matches = fixedSearchResults();
      if (matches.length !== 1) throw Error("Expected exactly one visible result for the fixed DeepRead passage");
      matches[0].click();
    } else throw Error("Unknown reviewed DeepRead operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    get caseId() { return activeCaseId(); }, state: state, perform: perform
  };
})();
