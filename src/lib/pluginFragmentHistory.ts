/** Resolve same-document fragments against the sandbox document, not its parent base URL. */
export function installPluginFragmentHistory(target: Pick<Window,"history"|"location">): void {
  if (!/^about:(?:srcdoc|blank)(?:#|$)/.test(target.location.href)) return;
  for (const method of ["pushState","replaceState"] as const) {
    const original=target.history[method].bind(target.history);
    target.history[method]=(state:unknown,title:string,url?:string|URL|null) => {
      const resolved=typeof url==="string" && url.startsWith("#")
        ? target.location.href.split("#")[0]+url : url;
      // Keep native state/length/popstate and native URL/security validation.
      // An opaque srcdoc's inherited base otherwise resolves '#/' to its host.
      return original(state,title,resolved);
    };
  }
}

export function pluginFragmentHistoryScript():string {
  return `<script data-atools-fragment-history>(${installPluginFragmentHistory.toString()})(window);</script>`;
}
