import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { runPublishedBusinessScenario as runRegex } from "./nativePublishedRegexScenario";
import { runPublishedBusinessScenario as runColor } from "./nativePublishedColorHelperScenario";
import { runPublishedBusinessScenario as runTimestamp } from "./nativePublishedTimestampScenario";
import { runPublishedBusinessScenario as runTodo } from "./nativePublishedTodoScenario";
import { runOriginalCronScenario } from "./nativeOriginalCronScenario";
import { runOriginalContentScenario } from "./nativeOriginalContentScenario";
import { runOriginalCalculationScenario } from "./nativeOriginalCalculationScenario";
import { runHeadCalculationPaperScenario } from "./nativeOriginalCalculationHeadScenario";
import { runOriginalCodecScenario } from "./nativeOriginalCodecScenario";
import { runOriginalJsonEditorScenario } from "./nativeOriginalJsonEditorScenario";
import { runOriginalJsonWorkerContractScenario } from "./nativeOriginalJsonWorkerContractScenario";
import { runOriginalCalculatorScenario } from "./nativeOriginalCalculatorScenario";
import { runOriginalUuidScenario } from "./nativeOriginalUuidScenario";
import { runOriginalAsciiTreeScenario } from "./nativeOriginalAsciiTreeScenario";
import { runOriginalPlainTextScenario } from "./nativeOriginalPlainTextScenario";
import { runOriginalSubnetScenario } from "./nativeOriginalSubnetScenario";
import { runConvertedTetrisScenario } from "./nativePublishedTetrisScenario";
import { runDeepReadScenario } from "./nativePublishedDeepReadScenario";
import { runOriginalMybatisScenario } from "./nativeOriginalMybatisScenario";
import { runOriginalRandomDataScenario } from "./nativeOriginalRandomDataScenario";
import { runOriginalImageStitchScenario } from "./nativeOriginalImageStitchScenario";

export async function runPublishedBusinessScenario(context: PublishedScenarioContext) {
  if (context.profile.caseId === "regex-editor") return runRegex(context);
  if (context.profile.caseId === "color-helper") return runColor(context);
  if (context.profile.caseId === "com-ztools-timestamp") return runTimestamp(context);
  if (context.profile.caseId === "todo-neo") return runTodo(context);
  if (context.profile.caseId === "converted-todo-neo-source") return runTodo(context);
  if (context.profile.caseId === "local-cron") return runOriginalCronScenario(context);
  if (context.profile.caseId === "local-content-workbench") return runOriginalContentScenario(context);
  if (context.profile.caseId === "local-calculation-paper") return runOriginalCalculationScenario(context);
  if (context.profile.caseId === "local-calculation-paper-head") return runHeadCalculationPaperScenario(context);
  if (context.profile.caseId === "local-developer-codec-tools") return runOriginalCodecScenario(context);
  if (context.profile.caseId === "local-my-calculator-zpx") return runOriginalCalculatorScenario(context);
  if (context.profile.caseId === "converted-my-calculator-source") return runOriginalCalculatorScenario(context);
  if (context.profile.caseId === "local-uuid-kit") return runOriginalUuidScenario(context);
  if (context.profile.caseId === "local-ascii-tree") return runOriginalAsciiTreeScenario(context);
  if (context.profile.caseId === "local-plain-text") return runOriginalPlainTextScenario(context);
  if (context.profile.caseId === "local-subnet-calculator") return runOriginalSubnetScenario(context);
  if (context.profile.caseId === "local-mybatis-sql-formatter-head") return runOriginalMybatisScenario(context);
  if (context.profile.caseId === "local-random-data-head") return runOriginalRandomDataScenario(context);
  if (context.profile.caseId === "local-image-stitch-head") return runOriginalImageStitchScenario(context);
  if (context.profile.caseId === "converted-tetris-source") return runConvertedTetrisScenario(context);
  if (context.profile.caseId === "converted-deepread-source") return runDeepReadScenario(context);
  if (context.profile.caseId === "local-json-editor") {
    return context.fixture.workerContractOnly === true
      ? runOriginalJsonWorkerContractScenario(context)
      : runOriginalJsonEditorScenario(context);
  }
  throw Error("No reviewed business scenario registered for " + context.profile.caseId);
}
