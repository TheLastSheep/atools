import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-search-feedback-"));
const outFile = join(outDir, "searchFeedback.mjs");

try {
  const sourcePath = new URL("src/lib/searchFeedback.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "", resultCount: 0, remoteStatus: "idle" }),
    { mode: "none", title: "", hint: "", showSpinner: false },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "rust", resultCount: 0, remoteStatus: "searching" }),
    {
      mode: "loading",
      title: "正在搜索 “rust”",
      hint: "正在匹配系统命令、网页快开、本地启动和插件指令",
      showSpinner: true,
    },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "g rust", resultCount: 1, remoteStatus: "searching" }),
    {
      mode: "strip",
      title: "正在补充插件结果",
      hint: "已显示本地匹配，插件搜索完成后会自动合并",
      showSpinner: true,
    },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "zzzz", resultCount: 0, remoteStatus: "ready" }),
    {
      mode: "empty",
      title: "没有找到匹配 “zzzz” 的命令",
      hint: "输入 “>” 可查看系统命令，或检查网页快开、本地启动配置",
      showSpinner: false,
    },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "zzzz", resultCount: 0, remoteStatus: "unavailable" }),
    {
      mode: "empty",
      title: "没有找到本地匹配 “zzzz”",
      hint: "浏览器预览仅搜索系统命令、网页快开和本地启动；桌面应用会继续搜索插件",
      showSpinner: false,
    },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "rust", resultCount: 0, remoteStatus: "error", error: "IPC failed" }),
    {
      mode: "error",
      title: "插件搜索失败",
      hint: "已完成本地匹配，但插件搜索返回错误：IPC failed",
      showSpinner: false,
    },
  );

  assert.deepEqual(
    mod.searchFeedbackFor({ query: "rust", resultCount: 2, remoteStatus: "error", error: "IPC failed" }),
    {
      mode: "strip",
      title: "插件搜索失败，已显示本地结果",
      hint: "IPC failed",
      showSpinner: false,
    },
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
