export const desktopBusinessCases = [
  { id: "ideadock", category: "web-csv-editor-parser", ui: true, coverage: "Original RFC4180 parser; account, AI and clipboard flows are not asserted", async probe(ctx) {
    await ctx.test("original-csv-parser-preserves-quoted-comma-and-newline", () => {
      const rows = window.parseCsv('name,value\n"a,b","line1\nline2"\n');
      ctx.check(rows.length === 2 && rows[1][0].value === "a,b" && rows[1][1].value === "line1\nline2", "Original RFC4180 cells differ");
      return { rows: rows.length, quotedComma: rows[1][0].value, multiline: rows[1][1].value };
    });
  } },
  { id: "Image-Toolbox", category: "node-image-file-import", ui: true, async probe(ctx) {
    await ctx.test("original-image-import-reads-real-png", () => {
      const data = window.readImageFile(ctx.config.pngFile);
      ctx.check(data === ctx.config.pngDataUrl, "Original image importer MIME/base64 differs"); return { actualPngImported: true };
    });
  } },
  { id: "lihua", category: "web-confetti-effect", ui: true, coverage: "Original confetti effect; separate overlay windows and audio are not asserted", async probe(ctx) {
    await ctx.test("original-confetti-fire-creates-and-finishes-effect", async () => {
      const pending = window.fire(0.02, { ticks: 2, disableForReducedMotion: false });
      ctx.check(pending && typeof pending.then === "function", "Original confetti did not return its effect promise");
      ctx.check(document.querySelectorAll("canvas").length >= 1, "Original effect canvas missing");
      await pending; return { effectCompleted: true };
    });
  } },
  { id: "musicsquare", category: "web-local-playlist-ui", ui: true, coverage: "Original in-page playlist creation; no catalog search, streaming or persisted account state is claimed", async probe(ctx) {
    await ctx.test("original-local-playlist-creation-renders-option", () => {
      document.querySelector("#new-playlist-btn").click();
      document.querySelector("#playlist-name-input").value = "离线验证歌单";
      document.querySelector("#playlist-confirm-btn").click();
      const options = [...document.querySelectorAll("#playlist-select option")];
      ctx.check(options.some(option => option.textContent === "离线验证歌单" && option.selected), "Original playlist creation did not render selected playlist"); return { playlistCreated: true };
    });
  } },
  { id: "snipaste", category: "node-image-buffer-memory-only", ui: false, coverage: "Original PNG IHDR parser on in-memory bytes only; no UI, screenshot, file operation, clipboard or native window is executed", async probe(ctx) {
    await ctx.test("original-png-ihdr-parser", () => {
      const result = window.services.parsePngDimensions(Buffer.from(ctx.config.pngBase64, "base64"));
      ctx.check(result?.width === 1 && result.height === 1, "Original PNG IHDR dimensions differ");
      ctx.check(window.services.parsePngDimensions(Buffer.from("invalid-png-signature-at-least-24-bytes")) === null, "Invalid PNG signature must be rejected");
      ctx.check(window.services.parsePngDimensions(Buffer.from(ctx.config.pngBase64, "base64").subarray(0, 20)) === null, "Short PNG must be rejected");
      return { ...result, invalidSignatureRejected: true, shortBufferRejected: true };
    });
  } },
  { id: "stickercan", category: "node-sticker-image-export", ui: true, coverage: "Original local image save/delete; cloud accounts and upload are not asserted", async probe(ctx) {
    await ctx.test("original-sticker-save-and-readback-real-image", async () => {
      const target = ctx.config.outputFile + ".png";
      const saved = await window.emotionCan.saveFile(ctx.config.pngDataUrl, target);
      ctx.check(saved === target && window.emotionCan.fileExists(target), "Original sticker export missing");
      const bytes = window.__atoolsNodeModuleRequire("node:fs").readFileSync(target);
      ctx.check(bytes.toString("base64") === ctx.config.pngBase64, "Original exported PNG bytes differ");
      ctx.check(window.emotionCan.deleteFile(target), "Original scratch sticker delete failed"); return { exportedBytesMatch: true, scratchFileDeleted: true };
    });
  } },
  { id: "totodo", category: "web-calendar-lunar-conversion", ui: true, coverage: "Original calendar date conversion; todo DB persistence and AI reports are not asserted", async probe(ctx) {
    await ctx.test("original-calendar-lunar-new-year-conversion", () => {
      const first = window.getLunar(new Date(2025, 0, 29)), second = window.getLunar(new Date(2025, 0, 30));
      ctx.check(first === "正月" && second === "初二", "Original lunar calendar conversion differs"); return { first, second };
    });
  } },
  { id: "system-manager", category: "web-system-chart-path", ui: true, coverage: "Original utilization chart geometry; OS repair, cleanup, wallpaper and process actions are not asserted", async probe(ctx) {
    await ctx.test("original-utilization-chart-clamps-values-and-closes-area", () => {
      const path = window.generateSvgSmoothPath([0, 50, 150], 240, 130, 100);
      ctx.check(path.lastX === 240 && path.lastY === 14 && path.d.startsWith("M ") && path.areaD.endsWith(" Z"), "Original CPU/memory chart path differs"); return { lastX: path.lastX, lastY: path.lastY, closedArea: true };
    });
  } },
  { id: "startup-manager", category: "node-macos-readonly-startup-scan", ui: true, async probe(ctx) {
    await ctx.test("original-startup-scan-must-not-pass-fallback-empty-snapshot", async () => {
      const output = await window.startupManager.scan();
      ctx.check(output?.ok === true, "Original startup scan returned an error");
      const snapshot = output.value;
      ctx.check(snapshot?.platform === "darwin" && typeof snapshot.snapshotId === "string" && snapshot.snapshotId.length > 0 && Array.isArray(snapshot.items), "HOST_API_UNAVAILABLE: original dynamic adapter require fell back or real snapshot is unavailable");
      return { platform: snapshot.platform, snapshotCreated: true, itemCount: snapshot.items.length };
    });
  } },
  { id: "image-batch-studio", category: "node-native-image-transform", ui: true, async probe(ctx) {
    await ctx.test("original-image-engine-processes-real-png-or-reports-missing-runtime", async () => {
      const status = await window.services.runtimeStatus();
      if (status.state !== "ready") ctx.block(`Original native image engine state=${status.state}; no runtime installation or fake successful conversion`);
      const results = await window.services.processImages([ctx.config.pngFile], { output: { directory: ctx.config.scratchDir }, format: { type: "png" }, resize: { width: 2, height: 2, fit: "fill" } });
      ctx.check(results?.length === 1 && results[0].ok && results[0].outputPath?.startsWith(ctx.config.scratchDir + "/"), "Original image engine did not create scratch output");
      ctx.check(window.__atoolsNodeModuleRequire("node:fs").statSync(results[0].outputPath).size > 0, "Original image output bytes missing"); return { converted: true, scratchOutputExists: true };
    });
  } },
];
