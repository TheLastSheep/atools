// Installed only in generated private BrowserWindow acceptance packages.
(() => {
  let current = null, stage = "idle";
  const pause = () => new Promise(resolve => setTimeout(resolve, 15));
  async function until(read) {
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) { if (read()) return; await pause(); }
    throw Error("GeometryConfirmationDeadline");
  }
  function validBounds(value) {
    return value && !value.then && [value.x, value.y, value.width, value.height].every(Number.isFinite)
      && value.width > 0 && value.height > 0;
  }
  function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  window.__AToolsWindowGeometryFixture = {
    state() { return { stage, hasHandle: !!current, hasHostId: typeof current?.id === "string" && current.id.length > 0, destroyed: current?.isDestroyed() ?? null }; },
    async close() {
      const handle = current; current = null;
      return handle ? { closed: (await handle.close())?.closed === true, destroyed: handle.isDestroyed() } : { closed: false };
    },
    async run() {
      stage = "GEOMETRY_CREATE_FAILED";
      const win = current = window.utools.createBrowserWindow("page/Tips/successTips.html", {
        x: 24, y: 24, width: 460, height: 220, minWidth: 100, minHeight: 80, maxWidth: 1000, maxHeight: 800, show: false,
      });
      try {
        stage = "GEOMETRY_READY_REJECTED";
        await win.ready;
        stage = "GEOMETRY_SYNCHRONOUS_CONTRACT_FAILED";
        const initial = win.getBounds(), info = window.__AToolsOriginalGeometryInfo(win);
        const getters = [win.getSize(), win.getContentSize(), win.getPosition(), win.getMinimumSize(), win.getMaximumSize()];
        if (!validBounds(initial) || getters.some(value => !Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite))) throw Error("GeometrySynchronousContract");
        const copy = win.getBounds(); copy.width = 99999;
        const defensiveCopies = win.getBounds().width === initial.width;
        const moveExpected = { x: Math.round(initial.x + 12), y: Math.round(initial.y + 7), width: initial.width, height: initial.height };
        let eventSnapshot = null;
        win.once("move", () => { eventSnapshot = win.getBounds(); });
        stage = "GEOMETRY_MOVE_UNCONFIRMED";
        window.__AToolsOriginalGeometryMove(win, { dx: 12, dy: 7 });
        await until(() => equal(win.getBounds(), moveExpected) && eventSnapshot !== null);
        const afterMove = win.getBounds();
        const resizeExpected = { x: afterMove.x, y: afterMove.y, width: 420, height: 180 };
        stage = "GEOMETRY_RESIZE_UNCONFIRMED";
        window.__AToolsOriginalGeometryResize(win, { width: 120, height: 100 });
        await until(() => equal(win.getBounds(), resizeExpected));
        stage = "GEOMETRY_NESTED_REJECTED";
        const nested = await win.webContents.executeJavaScript(`(async()=>{
          const child=window.utools.createBrowserWindow('page/Tips/successTips.html',{x:16,y:16,width:220,height:140,minWidth:100,minHeight:80,show:false});
          try {await child.ready;const before=child.getBounds();await child.setBounds({...before,x:before.x+3,y:before.y+2});
            const after=child.getBounds();return {synchronous:!before.then&&!after.then,finite:[after.x,after.y,after.width,after.height].every(Number.isFinite),
              updated:after.x===before.x+3&&after.y===before.y+2};}finally{await child.close();}
        })()`);
        return { windowId: win.id, synchronous: true, initial, info, getters, defensiveCopies,
          moveExpected, afterMove, eventSnapshot, eventSawConfirmedState: equal(eventSnapshot, afterMove),
          resizeExpected, afterResize: win.getBounds(), afterInfo: window.__AToolsOriginalGeometryInfo(win), nested };
      } catch (error) {
        await this.close();
        const failure = error instanceof Error ? error : Error("GeometryFixtureFailure");
        failure.fixtureDiagnostic = { step: "scenario-check", errorClass: ["TypeError", "ReferenceError", "RangeError", "Error"].includes(failure.name) ? failure.name : "Error", knownErrorCode: stage };
        throw failure;
      }
    },
  };
})();
