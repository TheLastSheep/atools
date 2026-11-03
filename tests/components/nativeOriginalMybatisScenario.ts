import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
type MybatisState = { ready: boolean; input: string; output: string; info: string; errorVisible: boolean; errorText: string };
const EXPECTED_INPUT = "[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE id = ? AND name = ?\n[DEBUG] - ==> Parameters: 1(Integer), Tom(String)";
const EXPECTED_SQL = "SELECT *\nFROM user\nWHERE id = 1\nAND name = 'Tom'";
const EDGE_INPUT = "[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE name = ? AND note = ? AND id = ?\n[DEBUG] - ==> Parameters: O'Neil(String), null, 7(Integer)";
const EDGE_SQL = "SELECT *\nFROM user\nWHERE name = 'O''Neil'\nAND note = NULL AND id = 7";
const EXPECTED_ERROR = "未找到包含 Preparing: 的日志行，请检查输入是否为 MyBatis SQL 日志";

export async function runOriginalMybatisScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const read = () => context.probe<MybatisState>("state");
  const wait = (matches: (state: MybatisState) => boolean, label: string) => context.until(async () => {
    const state = await read(); context.observations.originalMybatisLastState = state;
    return state.ready && matches(state) ? state : null;
  }, label);
  await wait(() => true, "Original MyBatis formatter controls did not mount");
  context.setPhase("original-mybatis-format-sql");
  await context.probe("valid-input");
  let formatted = await context.probe<MybatisState>("format");
  formatted = await wait(state => state.output === EXPECTED_SQL && state.info === "参数数量: 2" && !state.errorVisible,
    "Original formatter did not render the fixed two-parameter SQL");
  context.check(formatted.output === EXPECTED_SQL && formatted.info === "参数数量: 2",
    "Original UI renders the expected SQL and reports two parameters");

  context.setPhase("original-mybatis-error-recovery");
  await context.probe("invalid-input");
  const failed = await context.probe<MybatisState>("format");
  const error = await wait(state => state.errorVisible && state.errorText === EXPECTED_ERROR
    && state.output === EXPECTED_SQL && state.info === "参数数量: 2", "Invalid input did not retain prior result while showing the original error");
  context.check(failed.errorVisible && error.output === EXPECTED_SQL,
    "Original error is visible and a failed attempt preserves the previous SQL result");
  await context.probe("valid-input");
  const recovered = await context.probe<MybatisState>("format");
  const recoveredState = await wait(state => !state.errorVisible && state.output === EXPECTED_SQL && state.info === "参数数量: 2",
    "Valid MyBatis input did not recover after an error");
  context.check(recovered.output === EXPECTED_SQL && !recoveredState.errorVisible,
    "Original formatter recovers on the valid fixed log after an error");

  context.setPhase("original-mybatis-format-edge-parameters");
  await context.probe("edge-input");
  const edgeFormatted = await context.probe<MybatisState>("format");
  const edge = await wait(state => state.output === EDGE_SQL && state.info === "参数数量: 3" && !state.errorVisible,
    "Original formatter did not render the fixed escaped-string/null/three-parameter SQL");
  context.check(edgeFormatted.output === EDGE_SQL && edge.output === EDGE_SQL && edge.info === "参数数量: 3",
    "Original UI escapes the string quote, renders null, and reports three parameters");

  context.setPhase("original-mybatis-clear");
  const cleared = await context.probe<MybatisState>("clear");
  const final = await wait(state => state.input === "" && state.output === "" && state.info === "" && !state.errorVisible,
    "Original clear button did not empty the formatter state");
  context.check(cleared.input === "" && final.output === "" && final.info === "",
    "Original clear button removes the input, prior result and parameter count");
  context.observations.originalMybatisResult = { fixedInputLength: EXPECTED_INPUT.length,
    sqlBytes: new TextEncoder().encode(recoveredState.output).length, parameterCount: 2,
    edgeInputLength: EDGE_INPUT.length, edgeSqlBytes: new TextEncoder().encode(edge.output).length, edgeParameterCount: 3 };
  return { tested: ["original MyBatis fixed-log DOM input", "exact two-parameter SQL output", "invalid-input error with previous result retained", "valid-input recovery", "escaped-string/null/three-parameter SQL output", "clear resets the UI"],
    notTested: ["physical keyboard or pointer", "copy/clipboard", "other log dialects", "accounts, files, network or persistence"],
    boundary: "Real original MyBatis UI controls in the native host; the formatter service is reached only through the original format button." };
}
