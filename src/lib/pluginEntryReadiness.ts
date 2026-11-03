/** Inspect only actual script elements: inline business strings are not entry URLs. */
export function assertPluginEntryReady(html: string): void {
  const document = new DOMParser().parseFromString(html, "text/html");
  const source = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
    .map(script => script.getAttribute("src")?.trim() || "")
    .find(url => !/^(?:https?:|\/\/|data:|blob:)/i.test(url)
      && (/\.(?:tsx?|jsx|vue|svelte)(?:$|[?#])/i.test(url)
        || /(?:^|\/)src\/(?:main|index)\.[jt]sx?(?:$|[?#])/i.test(url)));
  if (source) {
    throw new Error("该插件仍是开发源码，尚未构建。请安装插件作者提供的发布版本，或先按该插件说明完成构建后重新导入。");
  }
}
