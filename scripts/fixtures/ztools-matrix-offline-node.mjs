// Original preload APIs execute locally; Node primitives touch scratch data only.
export const offlineNodeCases = [
  { id: "goose-note", category: "node-note-file-roundtrip", ui: true, coverage: "Original local-file mode API; original page startup errors remain separately recorded", async probe(ctx) {
    await ctx.test("original-note-write-read-and-directory-entry", () => {
      const api = window.gooseFs;
      ctx.check(api.writeFile(ctx.config.outputFile, ctx.config.text) === true, "Original note write failed");
      ctx.check(api.readFile(ctx.config.outputFile) === ctx.config.text && api.exists(ctx.config.outputFile), "Original note readback differs");
      const entries = api.readDir(ctx.config.scratchDir);
      ctx.check(entries.some(entry => entry.path === ctx.config.outputFile && entry.isFile), "Original note directory entry missing");
      return { readbackMatches: true, directoryContainsWrittenNote: true };
    });
  } },
  { id: "typora-markdown", category: "node-markdown-workspace", ui: true, async probe(ctx) {
    await ctx.test("original-markdown-create-write-read-title-excerpt", () => {
      const api = window.typoraBridge;
      const document = api.createDocument(ctx.config.scratchDir, "fixture-note.md", "# 初始标题\n\n内容");
      const changed = api.writeDocument(document.path, "# 更新标题\n\n真实 **业务** 内容");
      const actual = api.readDocument(document.path);
      ctx.check(changed.title === "更新标题" && actual.content.includes("真实 **业务** 内容") && actual.excerpt.includes("真实 业务 内容"), "Original Markdown document parsing/readback differs");
      return { title: actual.title, excerpt: actual.excerpt, actualFileReadback: true };
    });
  } },
  { id: "memo-quick-paste", category: "node-collection-digest-image", ui: true, async probe(ctx) {
    await ctx.test("original-collection-text-digest", () => {
      const digest = window.services.md5Format(ctx.config.text);
      ctx.check(digest === ctx.config.md5, "Original collection identity digest differs"); return { digest };
    });
  } },
  { id: "plain-text", category: "node-text-file-import", ui: true, coverage: "Original text-file import API; rendered editor startup is separately recorded", async probe(ctx) {
    await ctx.test("original-plain-text-file-import", () => {
      const text = window.services.readFile(ctx.config.inputFile);
      ctx.check(text === ctx.config.text, "Original plain-text importer differs"); return { text };
    });
  } },
  { id: "url-wizard", category: "node-bookmark-backup-roundtrip", ui: false, coverage: "Original backup API in isolated page; full Vue UI workflow not asserted", async probe(ctx) {
    await ctx.test("original-bookmark-backup-write-read", async () => {
      const content = JSON.stringify({ title: "fixture", url: "https://example.invalid" });
      await window.writeFile(ctx.config.outputFile, content);
      const actual = await window.readFile(ctx.config.outputFile);
      ctx.check(String(actual) === content, "Original URL wizard backup readback differs"); return { readbackMatches: true };
    });
  } },
  { id: "git-worktree-cockpit", category: "node-git-readonly-plan", ui: true, coverage: "Original dry plan generation; repository inspection needs host-selected directory approval", async probe(ctx) {
    await ctx.test("original-create-worktree-dry-plan-is-nonexecuting", () => {
      const plan = window.gitWorktreeCockpit.dryPlan("create");
      ctx.check(plan.action === "create" && plan.executable === false && plan.message.includes("只读"), "Original dry-plan boundary differs"); return plan;
    });
  } },
  { id: "archive-workbench", category: "original-archive-approval-boundary", ui: true, async probe(ctx) {
    await ctx.test("original-zip-inspection-requires-user-selection", async () => {
      let error; try { await window.services.inspectApprovedZipForMcp({}); } catch (value) { error = value; }
      ctx.check(error && /APPROVAL|ZIP|选择|授权/.test(String(error.code) + String(error.message)), "Original archive must reject missing grant");
      return { code: error.code, message: error.message };
    }, { kind: "validation" });
  } },
  { id: "plugin-guard", category: "original-plugin-scan-approval-boundary", ui: true, async probe(ctx) {
    await ctx.test("original-plugin-scan-requires-user-approved-directory", async () => {
      let error; try { await window.services.scanApprovedForMcp({}); } catch (value) { error = value; }
      ctx.check(error && /APPROVAL|GRANT|选择|授权/.test(String(error.code) + String(error.message)), "Original guard must reject missing directory grant"); return { code: error.code, message: error.message };
    }, { kind: "validation" });
  } },
  { id: "format-converter", category: "original-conversion-input-validation", ui: true, async probe(ctx) {
    await ctx.test("original-conversion-plan-rejects-invalid-fields", () => {
      let error; try { window.services.validatePlanToolInput({ unrelated: "fixture" }); } catch (value) { error = value; }
      ctx.check(error && /INVALID|字段|unsupported|不支持/.test(String(error.code) + String(error.message)), "Original format plan must reject unsupported fields"); return { code: error.code, message: error.message };
    }, { kind: "validation" });
  } },
  { id: "system-diagnostic-report", category: "host-system-report", ui: true, async probe(ctx) {
    await ctx.test("original-system-report-collection", async () => {
      const report = await window.systemReport.collect({ privacy: "fingerprint-minimal" });
      ctx.check(report?.overview?.platform === ctx.config.hostMetadata.platform && report.runtime?.nodeVersion
        && report.memory?.totalBytes > 0, "Original system report must contain actual platform, Node and memory values");
      return { platform: report.overview.platform, nodeVersion: report.runtime.nodeVersion, hasPositiveMemoryTotal: true, privacy: report.overview.privacy };
    });
  } },
];
