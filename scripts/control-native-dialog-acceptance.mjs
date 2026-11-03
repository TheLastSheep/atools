import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stages = ["awaiting-open-cancel", "awaiting-open-select", "awaiting-save-cancel", "awaiting-save-select"];

/** Requires current explicit user authorization; this helper never launches an application. */
export function reviewedDialogAction(checkpoint, stage, action) {
  if (!stages.includes(stage) || checkpoint.stage !== stage || checkpoint.control !== "awaiting_root_native_picker_control"
    || checkpoint.runtime?.nativeDialogs !== 1 || checkpoint.runtime?.dialogInvocations !== 1) throw Error("Expected live native fixture phase is absent");
  const privatePath = value => typeof value === "string"
    && /^\/private\/tmp\/atools-fixture-environment-[A-Za-z0-9]+\/native-fixture\//.test(value)
    && !value.split("/").includes("..");
  if (!privatePath(checkpoint.treeDirectory) || !checkpoint.treeDirectory.endsWith("/native-fixture/tree-data")
    || !privatePath(checkpoint.savePath) || checkpoint.savePath !== checkpoint.treeDirectory.replace(/tree-data$/, "export-output/tree-data@1x.png")) {
    throw Error("Native control is restricted to the exact private fixture targets");
  }
  if (action === "inspect") return [];
  if (action === "cancel" && stage.endsWith("cancel")) return [];
  if (stage.endsWith("select")) {
    if (action === "goto") return [stage === "awaiting-open-select" ? checkpoint.treeDirectory : dirname(checkpoint.savePath)];
    if (action === "confirm") return [];
    if (action === "name" && stage === "awaiting-save-select") return ["tree-data@1x.png"];
  }
  throw Error("Action is outside the four reviewed native operations");
}

async function main() {
  const [sessionFile, stage, action] = process.argv.slice(2);
  if (!sessionFile || !stage || !action || process.argv.length !== 5) throw Error("Session, exact phase and action required");
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  const checkpoint = JSON.parse(await readFile(session.checkpoint, "utf8"));
  const arguments_ = reviewedDialogAction(checkpoint, stage, action);
  const binary = session.nativeApplication?.executable;
  if (session.authorizedControl !== "AppleScript-four-private-operations"
    || typeof binary !== "string" || !/^\/private\/tmp\/atools-dialog-build-[A-Za-z0-9]+\/ATools Dialog QA [a-f0-9]{8}\.app\/Contents\/MacOS\/AToolsDialogSmoke$/.test(binary)) {
    throw Error("Explicitly authorized unique fixture application identity required");
  }
  const processes = execFileSync("ps", ["-ww", "-Ao", "pid=,args="], { encoding: "utf8" }).split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean)
    .filter(match => match[2].startsWith(binary + " "));
  if (processes.length !== 1) throw Error("Exactly one live process with this fixture executable is required");
  const pid = Number(processes[0][1]), startedAt = new Date().toISOString();
  const script = fileURLToPath(new URL("./native-dialog-acceptance-control.applescript", import.meta.url));
  let output, error;
  try { output = execFileSync("osascript", [script, String(pid), action, ...arguments_], { encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 }).trim(); }
  catch (failure) { error = String(failure.message); }
  const record = { startedAt, finishedAt: new Date().toISOString(), stage, action, pid,
    runtimeBefore: checkpoint.runtime, output, error, control: "explicitly authorized AppleScript on the exact private fixture process" };
  await appendFile(session.audit, JSON.stringify(record) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(record));
  if (error) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
