import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const agentTools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const agentToolTests = await readFile(new URL("src-tauri/tests/agent_tools_tests.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

const optionsStart = agentTools.indexOf("pub struct FindLocalFilesOptions");
assert.notEqual(optionsStart, -1, "FindLocalFilesOptions should exist");
const optionsEnd = agentTools.indexOf("\n}", optionsStart);
const optionsBody = agentTools.slice(optionsStart, optionsEnd);
assert.ok(optionsBody.includes("pub limit: usize"), "find_local_files should keep a bounded result limit");
assert.ok(optionsBody.includes("pub max_depth: Option<usize>"), "find_local_files should support max_depth");
assert.ok(optionsBody.includes("pub ignore_dirs: Vec<String>"), "find_local_files should support ignore_dirs");
assert.ok(optionsBody.includes("pub ignore_patterns: Vec<String>"), "find_local_files should support ignore_patterns");

const toolCallStart = agentTools.indexOf("fn find_local_files_tool_call");
assert.notEqual(toolCallStart, -1, "find_local_files tool call should exist");
const toolCallEnd = agentTools.indexOf("\nfn rename_files_tool_call", toolCallStart);
const toolCallBody = agentTools.slice(toolCallStart, toolCallEnd);
assert.ok(toolCallBody.includes('.get("max_depth")'), "tool call should parse max_depth");
assert.ok(toolCallBody.includes(".map(|depth| depth.min(100) as usize)"), "tool call should clamp max_depth");
assert.ok(toolCallBody.includes('.get("ignore_dirs")'), "tool call should parse ignore_dirs");
assert.ok(toolCallBody.includes("unwrap_or_else(default_ignored_dirs)"), "tool call should use default ignored dirs when ignore_dirs is omitted");
assert.ok(toolCallBody.includes('.get("ignore_patterns")'), "tool call should parse ignore_patterns");
assert.ok(toolCallBody.includes('"skipped_permission_errors": report.skipped_permission_errors'), "tool call should expose skipped permission error count");

const visitStart = agentTools.indexOf("fn visit_files(");
assert.notEqual(visitStart, -1, "file traversal should exist");
const visitEnd = agentTools.indexOf("\nfn slash_path", visitStart);
const visitBody = agentTools.slice(visitStart, visitEnd);
assert.ok(visitBody.includes(".map(|max_depth| depth > max_depth)"), "traversal should stop after max_depth");
assert.ok(visitBody.includes("error.kind() == ErrorKind::PermissionDenied"), "traversal should detect permission errors");
assert.ok(visitBody.match(/skipped_permission_errors \+= 1/g)?.length >= 3, "traversal should count permission errors in read_dir/entry/file_type paths");
assert.ok(visitBody.includes("file_type.is_dir() && options.ignore_dirs.iter().any"), "traversal should skip configured ignore_dirs");
assert.ok(visitBody.includes("matches_ignore_patterns("), "traversal should apply ignore_patterns before matching or descending");
assert.ok(visitBody.includes("visit_files(&path, base_root, query_lower, options, depth + 1, report)"), "traversal should recurse with depth tracking");

const patternStart = agentTools.indexOf("fn matches_ignore_patterns(");
assert.notEqual(patternStart, -1, "ignore pattern matcher should exist");
const patternEnd = agentTools.indexOf("\nfn default_ignored_dirs", patternStart);
const patternBody = agentTools.slice(patternStart, patternEnd);
assert.ok(patternBody.includes('pattern.strip_suffix("/**")'), "ignore_patterns should support generated/** subtree patterns");
assert.ok(patternBody.includes("wildcard_match(pattern, file_name)"), "ignore_patterns should match filenames such as *.tmp");
assert.ok(patternBody.includes("wildcard_match(pattern, relative_path)"), "ignore_patterns should match relative paths");
assert.ok(patternBody.includes("fn wildcard_match"), "ignore_patterns should use wildcard matching");

const toolStart = agentTools.indexOf('tool(\n        "find_local_files"');
assert.notEqual(toolStart, -1, "find_local_files tool definition should exist");
const toolEnd = agentTools.indexOf("\n}\n\nfn ocr_image_tool", toolStart);
const toolBody = agentTools.slice(toolStart, toolEnd);
assert.ok(toolBody.includes('"max_depth"'), "MCP schema should expose max_depth");
assert.ok(toolBody.includes('"ignore_dirs"'), "MCP schema should expose ignore_dirs");
assert.ok(toolBody.includes('"ignore_patterns"'), "MCP schema should expose ignore_patterns");
assert.ok(toolBody.includes('"skipped_permission_errors"'), "MCP schema should expose skipped_permission_errors");
assert.ok(toolBody.includes("*.tmp or generated/**"), "MCP schema should document wildcard examples");

for (const testName of [
  "find_local_files_respects_ignore_dirs_and_max_depth",
  "find_local_files_respects_ignore_patterns_for_files_and_paths",
  "find_local_files_skips_permission_denied_directories",
]) {
  const testStart = agentToolTests.indexOf(`fn ${testName}()`);
  assert.notEqual(testStart, -1, `Rust tests should cover ${testName}`);
}

const depthTestStart = agentToolTests.indexOf("fn find_local_files_respects_ignore_dirs_and_max_depth()");
const depthTestEnd = agentToolTests.indexOf("\n#[", depthTestStart + 1);
const depthTestBody = agentToolTests.slice(depthTestStart, depthTestEnd);
assert.ok(depthTestBody.includes("max_depth: Some(1)"), "Rust test should cover max_depth");
assert.ok(depthTestBody.includes('ignore_dirs: vec!["ignored".to_string()]'), "Rust test should cover ignore_dirs");
assert.ok(depthTestBody.includes("invoice-ignored.pdf"), "Rust test should prove ignored directory contents are skipped");

const patternTestStart = agentToolTests.indexOf("fn find_local_files_respects_ignore_patterns_for_files_and_paths()");
const patternTestEnd = agentToolTests.indexOf("\n#[", patternTestStart + 1);
const patternTestBody = agentToolTests.slice(patternTestStart, patternTestEnd);
assert.ok(patternTestBody.includes('"*.tmp".to_string()'), "Rust test should cover filename wildcard ignore");
assert.ok(patternTestBody.includes('"generated/**".to_string()'), "Rust test should cover relative subtree wildcard ignore");
assert.ok(patternTestBody.includes("invoice-cache.tmp"), "Rust test should create a tmp file to skip");
assert.ok(patternTestBody.includes("invoice-generated.pdf"), "Rust test should create a generated subtree file to skip");

const permissionTestStart = agentToolTests.indexOf("fn find_local_files_skips_permission_denied_directories()");
const permissionTestEnd = agentToolTests.indexOf("\n#[", permissionTestStart + 1);
const permissionTestBody = agentToolTests.slice(permissionTestStart, permissionTestEnd);
assert.ok(permissionTestBody.includes("PermissionsExt"), "Rust test should manipulate Unix permissions");
assert.ok(permissionTestBody.includes("from_mode(0o000)"), "Rust test should create a denied directory");
assert.ok(permissionTestBody.includes("report.skipped_permission_errors >= 1"), "Rust test should require skipped permission accounting");

const checkedRow = "- [x] `find_local_files` 支持 `ignore_dirs`、`max_depth`、权限错误跳过统计，以及 `ignore_patterns` 通配忽略；`*.tmp` 应忽略文件名，`generated/**` 应跳过相对路径子树。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark find_local_files ignore behavior complete");
