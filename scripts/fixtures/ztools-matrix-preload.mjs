export const preloadCases = [
  { id: "char-transform", category: "cjs-node-crypto-buffer", ui: false, async probe(ctx) {
    await ctx.test("original-md5-and-chinese-base64-roundtrip", () => {
      const api = window.charTransformApi;
      const md5 = api.transform(ctx.config.text, "md5");
      const encoded = api.transform(ctx.config.text, "base64");
      ctx.check(md5 === ctx.config.md5 && encoded === ctx.config.base64, "Original crypto/Buffer result differs");
      ctx.check(api.transform(encoded, "base64decode") === ctx.config.text, "Original Chinese decode differs");
      return { md5, encoded };
    });
  } },
  { id: "file-tree", category: "node-fs-local-dom-closures", ui: false, async probe(ctx) {
    await ctx.test("original-directory-scan-local-predicate", () => {
      const seen = [];
      const tree = window.services.scanDirectory(ctx.config.scanDir, false, name => { seen.push(name); return name === "ignore.txt"; });
      ctx.check(tree.children.length === 2 && seen.includes("ignore.txt"), "Original ignore closure must execute locally");
      ctx.check(tree.children[0].name === "folder" && tree.children[0].children[0].name === "inside.txt", "Directory scan shape/order differs");
      return { tree, predicateCalls: seen.length };
    });
  } },
  { id: "mybatis-sql-formatter", category: "pure-js-preload", ui: false, async probe(ctx) {
    await ctx.test("original-mybatis-parameter-replacement", () => {
      const output = window.services.formatMybatisLog("Preparing: select * from users where id=? and name=?\nParameters: 7(Integer), O'Neil(String)");
      ctx.check(output.paramCount === 2 && output.replaced.includes("id=7") && output.replaced.includes("'O''Neil'"), "Original SQL substitution/escaping differs");
      return output;
    });
  } },
  { id: "random-data", category: "pure-js-preload", ui: false, async probe(ctx) {
    await ctx.test("original-phone-generator-shape", () => {
      const values = Array.from({ length: 10 }, () => window.randomDataApi.generateSample("randomPhone"));
      ctx.check(values.every(value => /^1[3-9]\d{9}$/.test(value)), "Original phone generator emitted an invalid number");
      return { generated: values.length, allMatchMobilePattern: true };
    });
  } },
  { id: "ascii-tree", category: "node-fs-scratch-write", ui: false, async probe(ctx) {
    await ctx.test("original-text-export-writes-real-scratch-file", () => {
      const text = "root\n└── 站酷.txt";
      const saved = window.asciiTreeServices.writeTextFile(ctx.config.outputFile, text);
      const actual = window.__atoolsNodeModuleRequire("node:fs").readFileSync(ctx.config.outputFile, "utf8");
      ctx.check(saved === true && actual === text, "Original file export must write actual bytes");
      return { text: actual };
    });
  } },
  { id: "json-editor", category: "node-fs-scratch-read", ui: false, async probe(ctx) {
    await ctx.test("original-json-file-reader", () => {
      const actual = window.services.readFileContent(ctx.config.inputFile);
      ctx.check(actual === ctx.config.text, "Original fs-backed readFileContent differs");
      return { text: actual };
    });
  } },
  { id: "webhook-lab", category: "cjs-node-crypto-http", ui: false, async probe(ctx) {
    await ctx.test("original-hmac", () => {
      const actual = window.webhookLab.hmac(ctx.config.text, "fixture-secret", "sha256");
      ctx.check(actual === ctx.config.hmac, "Original HMAC differs from independent Node oracle");
      return { hmac: actual };
    });
    await ctx.test("original-loopback-http-server-start-stop", async () => {
      const address = await window.webhookLab.start({ port: 0 });
      ctx.check(address?.host === "127.0.0.1" && address.port > 0, "Original listener must bind loopback");
      await window.webhookLab.stop();
      return { boundLoopback: true };
    });
  } },
  { id: "subtitle-workbench", category: "cjs-node-buffer-local-core", ui: false, async probe(ctx) {
    await ctx.test("original-srt-analysis-and-shift", () => {
      const input = "1\n00:00:01,000 --> 00:00:03,000\n站酷字幕\n";
      const analysis = window.subtitleWorkbench.analyze(input, "srt");
      const shifted = window.subtitleWorkbench.transform(input, "srt", { type: "shift", milliseconds: 500 });
      ctx.check(analysis.cues.length === 1 && analysis.cues[0].start === 1000, "Original SRT parser differs");
      ctx.check(shifted.includes("00:00:01,500 --> 00:00:03,500") && shifted.includes("站酷字幕"), "Original subtitle shift differs");
      return { cueCount: analysis.cues.length, shifted };
    });
  } },
  { id: "openapi-contract-gate", category: "npm-yaml-and-dynamic-esm", sourceFiles: ["core/contract.js"], ui: false, async probe(ctx) {
    const compare = async () => {
      const before = { openapi: "3.0.0", info: { title: "fixture", version: "1" }, paths: { "/pets": { get: { responses: { "200": { description: "OK" } } } } } };
      const after = { ...before, paths: {} };
      const output = await window.services.compareInline({ before: JSON.stringify(before), after: JSON.stringify(after) });
      ctx.check(output?.counts?.breaking > 0 && output.findings?.length > 0 && output.gatePassed === false, "Original local finding collector must retain breaking removal results");
      return { counts: output.counts, gatePassed: output.gatePassed, findingCount: output.findings.length };
    };
    await ctx.test("original-openapi-inline-compare-cold", compare);
    await ctx.test("original-openapi-inline-compare-warm", compare);
  } },
  { id: "traditional-simplified-cn", category: "npm-opencc-electron", ui: false, async probe(ctx) {
    await ctx.test("original-traditional-simplified-conversion", () => {
      const text = window.nodeAPI.toSimplified("繁體轉換");
      ctx.check(text === "繁体转换", "Original OpenCC conversion differs");
      return { text };
    });
  } },
  { id: "har-doctor", category: "node-dynamic-file-esm", sourceFiles: ["core/analyze.js"], ui: false, async probe(ctx) {
    const analyze = async () => {
      const har = JSON.stringify({ log: { version: "1.2", creator: { name: "fixture", version: "1" }, entries: [
        { startedDateTime: "2026-10-15T00:00:00.000Z", time: 1500, request: { method: "GET", url: "https://fixture.invalid/items", headers: [] },
          response: { status: 503, headers: [], bodySize: 64, content: { size: 64, mimeType: "application/json" } }, timings: { wait: 1500 } },
      ] } });
      const output = await window.services.analyzeInlineForMcp({ har, detailLimit: 2 });
      const report = output?.reports?.[0];
      ctx.check(output?.reports?.length === 1 && report.metrics.entries === 1 && report.metrics.totalMs === 1500 && report.totals.errors === 1 && report.totals.slow === 1, "Original HAR analysis metrics/findings differ");
      return { reports: output.reports.length, metrics: report.metrics, errors: report.totals.errors, slow: report.totals.slow };
    };
    await ctx.test("original-inline-har-analysis-cold", analyze);
    await ctx.test("original-inline-har-analysis-warm", analyze);
  } },
  { id: "office-suite-workbench", category: "cjs-external-service-version-gate", ui: false, async probe(ctx) {
    await ctx.test("original-office-service-required-for-document-operation", async () => {
      ctx.check(typeof window.officeSuite?.run === "function", "HOST_SERVICE_UNAVAILABLE: original Office bridge is upgrade/version gated; no host version or OfficeCLI success is fabricated");
      const status = await window.officeSuite.getStatus();
      // A real status probe still does not establish document editing.
      ctx.block(`External OfficeCLI document editing is outside this fixture; original getStatus ok=${status?.ok === true}, errorCode=${status?.error?.code || "none"}`);
    });
  } },
];
