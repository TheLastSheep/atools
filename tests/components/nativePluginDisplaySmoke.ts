import { createPluginDisplayBridge, pluginDisplayBridgeScript } from "../../src/lib/pluginDisplayBridge";

type Call = { operation: string; elapsedMs: number; valid: boolean };
type DisplaySmokeReport = {
  passed: boolean;
  ungrantedThrowsWithoutTransport: boolean;
  closeThrowsWithoutTransport: boolean;
  identityConversion: boolean;
  unsupportedConversions: boolean;
  calls: Call[];
  errorCode?: string;
};

declare global {
  interface Window {
    startNativeDisplayFixture(config: { instanceId: string; endpoint: string }): void;
  }
}

function ungrantedChecks(): { throwsWithoutTransport: boolean; closed: boolean } {
  let permissionRequests = 0, transports = 0;
  const bridge = createPluginDisplayBridge({ instanceId: "ungranted-fixture" }, () => permissionRequests++, () => {
    transports++;
    return {};
  });
  let throws = true;
  const getters = [
    () => bridge.getPrimaryDisplay(),
    () => bridge.getAllDisplays(),
    () => bridge.getCursorScreenPoint(),
    () => bridge.getDisplayNearestPoint({ x: 0, y: 0 }),
    () => bridge.getDisplayMatching({ x: 0, y: 0, width: 8, height: 8 }),
  ];
  for (const getter of getters) {
    try {
      getter();
      throws = false;
    } catch (error) {
      throws &&= (error as { code?: string }).code === "ERR_ATOOLS_DISPLAY_PERMISSION_REQUIRED";
    }
  }
  bridge.close();
  let closed = false;
  try { bridge.getAllDisplays(); }
  catch (error) { closed = (error as { code?: string }).code === "ERR_ATOOLS_DISPLAY_CLOSED"; }
  return { throwsWithoutTransport: throws && permissionRequests === 1 && transports === 0, closed: closed && transports === 0 };
}

function geometryChecks(): { identity: boolean; unsupported: boolean } {
  const bridge = createPluginDisplayBridge({ instanceId: "geometry-fixture" }, () => {});
  const rect = { x: -12, y: 7, width: 80, height: 45 };
  const converted = bridge.dipToScreenRect(rect) as typeof rect;
  const identity = converted.x === rect.x && converted.y === rect.y && converted.width === rect.width && converted.height === rect.height;
  let unsupported = true;
  for (const convert of [bridge.screenToDipPoint, bridge.dipToScreenPoint, bridge.screenToDipRect]) {
    try { convert(); unsupported = false; }
    catch (error) { unsupported &&= (error as { code?: string }).code === "ERR_ATOOLS_DISPLAY_UNSUPPORTED"; }
  }
  return { identity, unsupported };
}

function startNativeDisplayFixture(config: { instanceId: string; endpoint: string }): void {
  const noGrant = ungrantedChecks(), geometry = geometryChecks();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:1px;height:1px;border:0;position:absolute;left:-10px;top:-10px";
  const bridge = pluginDisplayBridgeScript(config);
  const test = `
    (function(){
      function send(value){parent.postMessage({atoolsDisplayFixture:value},"*");}
      try {
        var api=window.__atoolsNativeDisplay, calls=[], operations=[
          ["getPrimaryDisplay",function(){return api.getPrimaryDisplay();}],
          ["getAllDisplays",function(){return api.getAllDisplays();}],
          ["getCursorScreenPoint",function(){return api.getCursorScreenPoint();}],
          ["getDisplayNearestPoint",function(){return api.getDisplayNearestPoint({x:0,y:0});}],
          ["getDisplayMatching",function(){return api.getDisplayMatching({x:0,y:0,width:8,height:8});}]
        ];
        for(var i=0;i<operations.length;i++) for(var j=0;j<4;j++) {
          var start=performance.now(), value=operations[i][1](), valid=false;
          if(operations[i][0]==="getAllDisplays") valid=Array.isArray(value)&&value.length>0;
          else if(operations[i][0]==="getCursorScreenPoint") valid=!!value&&Number.isFinite(value.x)&&Number.isFinite(value.y);
          else valid=!!value&&Number.isSafeInteger(value.id);
          calls.push({operation:operations[i][0],elapsedMs:performance.now()-start,valid:valid});
        }
        send({calls:calls});
      } catch(error) { var code=error&&typeof error.code==="string"&&/^ERR_ATOOLS_DISPLAY_[A-Z_]+$/.test(error.code)?error.code:"ERR_ATOOLS_DISPLAY_UNKNOWN";send({calls:calls,failed:true,errorCode:code}); }
    })();`;
  frame.srcdoc = `${bridge}<script>${test}</script>`;
  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || !event.data?.atoolsDisplayFixture) return;
    const value = event.data.atoolsDisplayFixture;
    const calls = Array.isArray(value.calls) ? value.calls : [];
    const expected = ["getPrimaryDisplay", "getAllDisplays", "getCursorScreenPoint", "getDisplayNearestPoint", "getDisplayMatching"];
    const counts = expected.every(name => calls.filter((item: Call) => item.operation === name).length === 4);
    const report: DisplaySmokeReport = {
      passed: calls.length === 20 && counts && calls.every((item: Call) => item.valid && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0) && value.failed !== true,
      ungrantedThrowsWithoutTransport: noGrant.throwsWithoutTransport,
      closeThrowsWithoutTransport: noGrant.closed,
      identityConversion: geometry.identity,
      unsupportedConversions: geometry.unsupported,
      calls: calls.map((item: Call) => ({ operation: item.operation, elapsedMs: item.elapsedMs, valid: item.valid })),
      ...(typeof value.errorCode === "string" && /^ERR_ATOOLS_DISPLAY_[A-Z_]+$/.test(value.errorCode) ? { errorCode: value.errorCode } : {}),
    };
    fetch("atools-display-smoke://localhost/report", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
    frame.remove();
  }, { once: true });
  document.body.append(frame);
}

(window as unknown as { startNativeDisplayFixture: typeof startNativeDisplayFixture }).startNativeDisplayFixture = startNativeDisplayFixture;
fetch("atools-display-smoke://localhost/ready", { method: "POST", body: "{}" }).catch(() => {});
