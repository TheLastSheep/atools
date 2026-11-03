import { expect, it } from "vitest";
import { runOriginalMybatisScenario } from "./nativeOriginalMybatisScenario";
import { requiresLegacyNodeSession } from "./nativePublishedRuntimeRequirement";
import type { PublishedScenarioContext, PublishedPluginProfile, PublishedFixture } from "./nativePublishedPluginCommon";
const sql = "SELECT *\nFROM user\nWHERE id = 1\nAND name = 'Tom'";
const edgeSql = "SELECT *\nFROM user\nWHERE name = 'O''Neil'\nAND note = NULL AND id = 7";
const edgeInput = "[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE name = ? AND note = ? AND id = ?\n[DEBUG] - ==> Parameters: O'Neil(String), null, 7(Integer)";
const errorText = "未找到包含 Preparing: 的日志行，请检查输入是否为 MyBatis SQL 日志";
function harness({ wrongSql = false, wrongEdgeSql = false } = {}) {
  const state = { ready: true, input: "", output: "", info: "", errorVisible: false, errorText: "" };
  const operations: string[] = [], phases: string[] = [], observations: Record<string, unknown> = {};
  const profile = { caseId: "local-mybatis-sql-formatter-head", id: "mybatis-sql-formatter", version: "1.0.0",
    featureCode: "format-sql-log", searchQuery: "sql", title: "MyBatis SQL 日志格式化", runtime: "web",
    dataAccess: false, pathAccess: "none", sourceKind: "local_full_directory", directorySha256: "a".repeat(64), fileCount: 5,
    verifyDataPersistence: false, dialogAccess: "none", sourceReviewStatus: "prepared_for_parent_native_fixture_decision",
    frameOperations: "tests/components/nativeOriginalMybatisFrameOperations.js" } satisfies PublishedPluginProfile;
  const fixture = { token: "fixture", runId: "00000000-0000-4000-8000-000000000000",
    packageSha256: profile.directorySha256!, profile } satisfies PublishedFixture;
  const probe = async <T>(operation: string): Promise<T> => {
    operations.push(operation);
    if (operation === "valid-input") state.input = "fixed valid SQL log";
    else if (operation === "edge-input") state.input = edgeInput;
    else if (operation === "invalid-input") state.input = "fixed invalid SQL log";
    else if (operation === "format" && state.input.includes("invalid")) {
      state.errorVisible = true; state.errorText = errorText;
    } else if (operation === "format") {
      const edge = state.input === edgeInput;
      state.output = edge ? (wrongEdgeSql ? "SELECT wrong edge" : edgeSql) : (wrongSql ? "SELECT wrong" : sql);
      state.info = edge ? "参数数量: 3" : "参数数量: 2"; state.errorVisible = false; state.errorText = "";
    } else if (operation === "clear") Object.assign(state, { input: "", output: "", info: "", errorVisible: false, errorText: "" });
    return { ...state } as unknown as T;
  };
  const context = { profile, fixture, check: (ok: unknown, label: string) => { if (!ok) throw Error(label); },
    until: async <T>(read: () => T | Promise<T>, label: string) => { const value = await read(); if (value) return value as NonNullable<T>; throw Error(label); },
    pause: async () => {}, probe, setPhase: (phase: string) => phases.push(phase), observations } as unknown as PublishedScenarioContext;
  return { context, operations, phases, state };
}

it("uses the default WebView route for its pinned pure-JavaScript preload", () => {
  const { context } = harness();
  expect(context.profile.runtime).toBe("web");
  expect(requiresLegacyNodeSession(context.profile)).toBe(false);
});

it("requires fixed SQL, error retention, recovery, edge parameters and clear through the same UI probe", async () => {
  const h = harness();
  const result = await runOriginalMybatisScenario(h.context);
  expect(h.operations).toEqual(["state", "valid-input", "format", "state", "invalid-input", "format", "state",
    "valid-input", "format", "state", "edge-input", "format", "state", "clear", "state"]);
  expect(h.phases).toEqual(["original-mybatis-format-sql", "original-mybatis-error-recovery",
    "original-mybatis-format-edge-parameters", "original-mybatis-clear"]);
  expect(h.state).toMatchObject({ input: "", output: "", info: "", errorVisible: false });
  expect(result.tested).toContain("escaped-string/null/three-parameter SQL output");
  expect(result.notTested).toContain("physical keyboard or pointer");
});

it("fails closed if the original UI renders a different SQL result", async () => {
  await expect(runOriginalMybatisScenario(harness({ wrongSql: true }).context)).rejects.toThrow("fixed two-parameter SQL");
});

it("fails closed if the original UI renders a different edge-parameter result", async () => {
  await expect(runOriginalMybatisScenario(harness({ wrongEdgeSql: true }).context))
    .rejects.toThrow("fixed escaped-string/null/three-parameter SQL");
});
