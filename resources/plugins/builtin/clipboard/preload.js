// 剪贴板插件预加载脚本
(function () {
  if (
    typeof window === "undefined"
    || !window.utools
    || typeof window.utools.onPluginReady !== "function"
    || typeof window.utools.onPluginEnter !== "function"
  ) {
    return;
  }

  const safeLoadClipboardHistory = () => {
    if (typeof window.loadClipboardHistory === "function") {
      window.loadClipboardHistory("");
    }
  };

  window.utools.onPluginReady(() => {
    safeLoadClipboardHistory();
  });

  window.utools.onPluginEnter(({ code }) => {
    safeLoadClipboardHistory();
  });
})();
