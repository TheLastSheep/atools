import { describe,expect,it,vi } from "vitest";
import { installPluginFragmentHistory,pluginFragmentHistoryScript } from "../../src/lib/pluginFragmentHistory";

describe("opaque plugin fragment history",()=>{
  it("normalizes router fragments to the actual srcdoc URL and delegates native state with the correct receiver",()=>{
    const history={pushState:vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(history);}),replaceState:vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(history);})};
    const push=history.pushState,replace=history.replaceState;
    installPluginFragmentHistory({location:{href:"about:srcdoc"},history} as any);
    history.replaceState({route:"/"},"","#/");
    history.pushState({route:"/next"},"","#/next");
    expect(replace).toHaveBeenCalledWith({route:"/"},"","about:srcdoc#/");
    expect(push).toHaveBeenCalledWith({route:"/next"},"","about:srcdoc#/next");
    history.pushState({},"","https://other.invalid/");
    expect(push).toHaveBeenLastCalledWith({},"","https://other.invalid/");
  });
  it("leaves ordinary file/HTTP documents untouched and never hides native validation failures",()=>{
    const original=vi.fn((..._args:unknown[])=>{throw new DOMException("blocked","SecurityError");});
    const history={pushState:original,replaceState:original};
    installPluginFragmentHistory({location:{href:"https://plugin.invalid/index.html"},history} as any);
    expect(history.pushState).toBe(original);
    expect(()=>history.pushState({},"","#/x")).toThrow("blocked");
    expect(pluginFragmentHistoryScript()).toContain("data-atools-fragment-history");
  });
});
