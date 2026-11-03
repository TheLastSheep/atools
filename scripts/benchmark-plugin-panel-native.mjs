import { cpus, release, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPluginPanelNativeFixture, createPanelFixtureEnvironment, repositoryRoot, runPluginPanelNativeFixture } from "./probe-plugin-panel-native.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { deriveEscapeTimelineMetrics, ESCAPE_TIMING_METRICS } from "./lib/native-panel-escape-timeline.mjs";

const execute=promisify(execFile);
const RUNS=5;
const WARM_QUERIES_PER_RUN=20;
export function parsePanelBenchmarkOptions(argv) {
  let destination, foreground=false;
  for(const argument of argv) {
    if(argument==="--foreground" && !foreground)foreground=true;
    else if(argument.startsWith("--") || destination)throw Error("Usage: benchmark-plugin-panel-native.mjs [OUTPUT] [--foreground]");
    else destination=argument;
  }
  return {output:resolve(destination || join(repositoryRoot,"output/legacy-node-2026-10-15/production-plugin-panel-performance"+(foreground?"-foreground":"")+".json")),
    windowMode:foreground?"foreground":"observe"};
}

function quantiles(values) {
  const ordered=[...values].filter(Number.isFinite).sort((a,b)=>a-b);
  const at=(p)=>ordered.length?ordered[Math.max(0,Math.ceil(p*ordered.length)-1)]:null;
  return {sampleCount:ordered.length,p50:at(.50),p95:at(.95),p99:at(.99),min:ordered[0]??null,max:ordered.at(-1)??null};
}
function metricGroup(runs,read) {return quantiles(runs.flatMap(run=>read(run)??[]));}
function fixtureEvidence(outcome) {
  return {
    originalSourcesUnchanged:outcome?.originalSourcesUnchanged??null,
    originalSourceHashes:outcome?.originalSourceHashes??null,
    charTransformUncaughtErrors:outcome?.observations?.charTransform?.errors??null,
    fileTreeUncaughtErrors:outcome?.observations?.fileTree?.errors??null,
    activeFrameUncaughtErrors:outcome?.frame?.errors??null,
  };
}
async function observeNativeProcessResources({ createSampler }) {
  const sampler = createSampler({ maxSamples: 360 });
  const errors = [];
  let pending = Promise.resolve(), busy = false;
  const capture = () => {
    if (busy) return pending;
    busy = true;
    pending = sampler.sample().catch(error => { errors.push(String(error)); }).finally(() => { busy = false; });
    return pending;
  };
  await capture();
  const timer = setInterval(() => { void capture(); }, 250);
  const observer = {
    report: null,
    stop: async () => {
      clearInterval(timer);
      await pending;
      try { await sampler.sample(); } catch (error) { errors.push(String(error)); }
      observer.report = sampler.report();
      observer.report.observationErrors = errors;
    },
  };
  return observer;
}
export function validatePanelDataset(outcome, expectedSamples=WARM_QUERIES_PER_RUN) {
  const dataset=outcome?.dataset, performance=outcome?.observations?.performance;
  if(dataset?.syntheticPlugins!==2 || dataset.syntheticFeatures!==1200 || dataset.originalPlugins!==2
    || !Number.isInteger(dataset.originalFeatures) || dataset.totalFeatures!==1200+dataset.originalFeatures
    || dataset.groups?.length!==2 || dataset.groups.some(group=>group.featureCount!==600
      || !Number.isInteger(group.originalQueryMatches) || group.originalQueryMatches<0 || group.originalQueryMatches>dataset.originalFeatures
      || group.expectedQueryResults!==group.featureCount+group.originalQueryMatches)
    || dataset.groups[0].pluginId===dataset.groups[1].pluginId)throw Error("Native panel dataset must identify two original plugins plus 1200 synthetic metadata features");
  if(JSON.stringify(performance?.dataset)!==JSON.stringify(dataset))throw Error("DOM timing dataset differs from the authoritative native fixture dataset");
  if(outcome.syntheticMetadataNeverActivated!==true)throw Error("Synthetic performance metadata was activated or lacks an activation audit");
  if(performance.warmSearch?.length!==expectedSamples)throw Error("Warm search sample count did not match the benchmark contract");
  for(const [index,sample] of performance.warmSearch.entries()) {
    const group=dataset.groups[index%2];
    if(sample.pluginId!==group.pluginId || sample.featureId!==group.pluginId || sample.query!==group.query
      || sample.resultCount!==group.expectedQueryResults || !Number.isInteger(sample.renderedRows) || sample.renderedRows<1 || sample.renderedRows>32)throw Error("Warm search did not prove a fresh synthetic owner with the exact synthetic-plus-original result count and bounded DOM");
  }
  return dataset;
}
export function validatePanelWindowEvidence(outcome, mode) {
  const evidence=outcome?.observations?.windowEvidence, performance=outcome?.observations?.performance, phases=performance?.escapePhases;
  if(evidence?.mode!==mode || performance?.windowMode!==mode || outcome.nativeWindowEvents?.mode!==mode
    || !Array.isArray(evidence.samples) || !evidence.samples.length)throw Error("Native window mode or OS evidence is missing");
  const nativeReady=value=>value?.nativeVisible===true && value.nativeFocused===true && value.appActive===true
    && value.appHidden===false && value.frontmostIsSelf===true;
  if(evidence.samples.some(sample=>sample.native?.mode!==mode
    || ["nativeVisible","nativeFocused","appActive","appHidden","frontmostIsSelf"].some(key=>typeof sample.native[key]!=="boolean")))throw Error("Native OS window snapshots are incomplete");
  if(mode==="foreground" && evidence.samples.some(sample=>!nativeReady(sample.native)
    || sample.parentVisibility!=="visible" || sample.parentDocumentHasFocus!==true))throw Error("Foreground benchmark lost actual OS activation or visible document focus");
  if(phases?.mode!==mode || phases.complete!==true)throw Error("Escape message/dispatch/DOM timeline is incomplete");
  const expectedMetrics=deriveEscapeTimelineMetrics(phases);
  if(ESCAPE_TIMING_METRICS.some(key=>phases[key]!==expectedMetrics[key]))throw Error("Escape metrics differ from the recorded clock observations");
  if(mode==="foreground" && (phases.frameVisibilityState!=="visible" || phases.frameDocumentHasFocus!==true
    || phases.parentVisibilityBefore!=="visible" || phases.parentDocumentHasFocusBefore!==true || phases.parentDocumentHasFocus!==true))throw Error("Foreground Escape frame/document proof is incomplete");
  for(const when of ["before","after"])if(!evidence.samples.some(sample=>sample.stage==="iframe-escape" && sample.when===when))throw Error("Escape OS window boundary missing: "+when);
  return evidence;
}
export function describe(runs) {
  const perf=run=>run?.observations?.performance??{};
  const rows=(run,key)=>perf(run)[key]??[];
  const phaseNames=[...new Set(runs.flatMap(run=>rows(run,"resources").map(sample=>sample.stage)))];
  const idleNames=[...new Set(runs.flatMap(run=>rows(run,"quietIdleWindows").map(sample=>sample.stage)))];
  const resourceStages=Object.fromEntries(phaseNames.map(stage=>[stage,{
    rssBytes:metricGroup(runs,run=>rows(run,"resources").filter(sample=>sample.stage===stage).map(sample=>sample.host.rssBytes)),
    hostCpuPercent:metricGroup(runs,run=>rows(run,"resources").filter(sample=>sample.stage===stage).map(sample=>sample.host.cpuPercentSincePreviousSample).filter(Number.isFinite)),
    runtimeStateSamples:runs.flatMap(run=>rows(run,"resources").filter(sample=>sample.stage===stage).map(sample=>sample.runtime)),
  }]));
  const quietIdleWindows=Object.fromEntries(idleNames.map(stage=>[stage,{
    quietWindowMs:metricGroup(runs,run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.host.quietWindowMs)),
    hostCpuPercent:metricGroup(runs,run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.host.after?.cpuPercentSincePreviousSample).filter(Number.isFinite)),
    cpuIntervalMs:metricGroup(runs,run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.host.after?.cpuIntervalMs).filter(Number.isFinite)),
    rssBeforeBytes:metricGroup(runs,run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.host.before?.rssBytes).filter(Number.isFinite)),
    rssAfterBytes:metricGroup(runs,run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.host.after?.rssBytes).filter(Number.isFinite)),
    runtimeStateSamples:runs.flatMap(run=>rows(run,"quietIdleWindows").filter(sample=>sample.stage===stage).map(sample=>sample.runtime)),
  }]));
  return {
    dataset:perf(runs[0]).dataset??null,
    launcherReadyMs:metricGroup(runs,run=>[perf(run).launcherReadyMs]),
    firstSearchAfterLauncherReadyMs:metricGroup(runs,run=>[perf(run).firstSearchAfterLauncherReady?.elapsedMs]),
    warmSearchReadyMs:metricGroup(runs,run=>rows(run,"warmSearch").map(sample=>sample.elapsedMs)),
    backButtonFocusRestoreMs:metricGroup(runs,run=>rows(run,"focusRestore").filter(sample=>sample.action==="back-button").map(sample=>sample.elapsedMs)),
    escapeProbeFocusRestoreMs:metricGroup(runs,run=>rows(run,"focusRestore").filter(sample=>sample.action==="iframe-escape-probe").map(sample=>sample.elapsedMs)),
    windowMode:perf(runs[0]).windowMode??"unrecorded",
    escapePipeline:Object.fromEntries([...ESCAPE_TIMING_METRICS,"panelRemovedObservedMs","focusRestoredObservedMs"]
      .map(key=>[key,metricGroup(runs,run=>[perf(run).escapePhases?.[key]])])),
    resources:{scope:"smoke-host-pid-only",excludes:["WKWebContent","Node sidecars","other helper processes","system-wide totals"],stages:resourceStages,quietIdleWindows,
      ownedProcessGroup:{
        scope:"exact launched executable/PID/start identity plus members of its exclusive process group; no application-wide memory claim",
        rssPeakBytes:metricGroup(runs,run=>[run.processResources?.peakRssBytes]),
        cpuPeakPercentOneCore:metricGroup(runs,run=>[run.processResources?.peakCpuPercentOneCore]),
        coverage:runs.map(run=>({runIndex:run.index??null,status:run.status??null,...run.processResources?.coverage})),
        unattributedWebKitCandidatePeakCount:metricGroup(runs,run=>run.processResources?.samples?.length
          ? [Math.max(...run.processResources.samples.map(sample=>sample.unattributedWebKitCandidates?.length??0))] : []),
        missingCategories:["WKWebContent and launchd/reparented XPC candidates stay separately observed and unattributed",
          "RSS is not physical footprint and is never added to the legacy host-only 300 MiB RSS budget",
          "sidecars outside the exclusive group require an explicitly captured exact pinned identity",
          "CPU deltas use only unchanged identities present at adjacent snapshot endpoints; short-lived process CPU can be omitted and peak CPU may understate the full interval"],
      }},
  };
}

async function main() {
  const {output:OUTPUT,windowMode}=parsePanelBenchmarkOptions(process.argv.slice(2));
  if(process.platform!=="darwin")throw Error("Native Wry panel performance fixture currently targets macOS only");
  const scratch=await mkdtemp(join("/private/tmp","atools-panel-performance-"));
  let environment, fixture;
  const runs=[];
  const report={schemaVersion:3,runId:randomUUID(),status:"running",createdAt:new Date().toISOString(),source:{commit:null},
    machine:{platform:process.platform,release:release(),arch:process.arch,node:process.version,cpuModel:cpus()[0]?.model??null,cpuCount:cpus().length,totalMemoryBytes:totalmem()},
    config:{windowMode,foregroundRequired:windowMode==="foreground",independentColdProcesses:RUNS,warmSearchSamplesPerProcess:WARM_QUERIES_PER_RUN,quantileMethod:"nearest-rank",thresholds:null,
      quantileInterpretation:"Descriptive only; sampleCount is included for every quantile set, and five fresh launches do not establish a stable P99 or product/release budget.",
      datasetExpected:{syntheticPlugins:2,syntheticFeatures:1200,originalPlugins:2,syntheticResultsPerWarmQuery:600,totalResultsPerWarmQuery:"600 + originalQueryMatches, computed from unchanged original command rules",maximumRenderedRows:32,scope:"Synthetic metadata measures search/render scale with original typed matches preserved; only two original plugins exercise actual business behavior, not 1200-plugin compatibility"},
      measurementBoundaries:{launcherReady:"smoke Rust clock starts immediately before building isolated Tauri/Wry app; ends after the real launcher search input is mounted and the native command replies",firstSearchAfterLauncherReady:"first user-like query in a fresh fixture process after launcher-ready; catalog refresh may already have completed, so this is not a cold matcher/backend measurement",warmSearchReady:"DOM input event to a selected production ResultRow for alternating synthetic plugin owners; ARIA must equal 600 synthetic features plus the exact original typed-rule match count, while at most 32 visible rows retain the new synthetic owner; includes frontend debounce, Rust search IPC, rendering, and MutationObserver delivery (not a paint or presentation timestamp)",focusRestore:"fixture button click or fixture Escape probe to launcher focus after panel removal; this is programmatic focus, not a physical global hotkey",quietIdleWindow:"two self-PID process refreshes around a 750ms Rust async timer after launcher-ready and after final close; the fixture has backgroundServices=false and is not formal application idle"},
      limitations:["Five process starts are descriptive samples; quantiles are not stable P99 confidence evidence or a release/competitor budget","Legacy RSS and CPU fields cover the isolated smoke host PID; the additional OS process-group sample includes only its exact launch identity and observed exclusive process group","WKWebContent and other launchd/reparented XPC processes are not attributed; candidate processes remain separate evidence","RSS KiB converted to bytes is not physical footprint and the legacy host-only 300 MiB RSS budget is not applied to a process-tree sum","Node/host runtime counters prove this fixture's owned session and listener state only, not the operating-system absence of every child process","Quiet windows disable fixture background services and do not represent full application idle or regular startup","The fixture starts after plugin metadata import and does not execute the regular builtin-plugin startup path","No physical hotkey, packaged release build, signed app, or user data is exercised","No OS-level network sandbox is applied; reviewed fixture plugin entry points only use local assets and the loopback bridge"]},
    runs,summary:null};
  report.config.measurementBoundaries.windowForeground=windowMode==="foreground"
    ?"Each measured stage first restores and verifies native visible/focused, AppKit active/not hidden, and NSWorkspace frontmost PID=self, plus visible document focus. No focus restoration occurs during a timed interval; after-samples must still pass."
    :"Observe mode does not restore or require OS foreground. Native and DOM states are recorded separately; this mode does not establish foreground latency even if DOM focus is present.";
  report.config.measurementBoundaries.escapePipeline="Request, three trace receipts, acknowledgement, unchanged deferred production Escape message, MutationObserver removal and focusin use the same parent performance.now clock with strict FIFO order. Request-to-frame-receipt-trace includes the frame's return-message queue, and after-keydown-trace-to-bridge is a gap between parent observations; neither is precise one-way transport or native timer delay. Only keydown dispatch uses frame-local monotonic time. Raw frame epochs stay diagnostic and are never subtracted from parent clocks. Missing/duplicate phases fail; legacy total retains 25ms polling granularity and is not a paint timestamp.";
  try {
    report.sourceBinding={scope:"Selected source inputs and generated artifacts; not full compiler closure or native runId echo",before:await capturePanelSources(repositoryRoot)};
    const {stdout}=await execute("git",["rev-parse","HEAD"],{cwd:repositoryRoot,timeout:3000});report.source.commit=stdout.trim();
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch);
    report.sourceBinding.artifactsBefore=await capturePanelArtifacts(fixture);
    for(let index=0;index<RUNS;index++) {
      environment=await createPanelFixtureEnvironment(repositoryRoot);
      environment.env.ATOOLS_PANEL_FOREGROUND_MODE=windowMode==="foreground"?"required":"observe";
      environment.evidence.panelWindowMode=windowMode;
      const runOutput=join(environment.root,`panel-run-${index+1}.json`);
      let outcome;
      try {
        outcome=await runPluginPanelNativeFixture(fixture,{output:runOutput,fixtureRoot:join(environment.root,"native-fixture"),env:environment.env,stdio:"ignore",onProcessStarted:observeNativeProcessResources});
        outcome.environment=environment.evidence;
        if (!outcome.processResources?.coverage?.exclusiveGroupProven
          || outcome.processResources.coverage.rootObservedSamples < 1
          || !outcome.processResources.samples?.some(sample => sample.rootLive)) {
          throw new Error("Owned process resource sampling did not capture a live exact launch identity in its exclusive process group");
        }
        validatePanelDataset(outcome);
        validatePanelWindowEvidence(outcome,windowMode);
        const measured={observations:{performance:outcome.observations.performance,windowEvidence:outcome.observations.windowEvidence}};
        runs.push({index:index+1,status:"ok",observations:measured.observations,metrics:describe([measured]),processResources:outcome.processResources,checks:outcome.checks,
          fixtureEvidence:fixtureEvidence(outcome),fixturePhases:outcome.fixturePhases,nativeWindowEvents:outcome.nativeWindowEvents,environment:outcome.environment});
      } catch(error) {
        outcome=error?.panelReport;
        if(!outcome)try {outcome=JSON.parse(await readFile(runOutput,"utf8"));} catch {}
        const observations=outcome?.observations?{performance:outcome.observations.performance,windowEvidence:outcome.observations.windowEvidence}:null;
        const measured=observations?{observations}:null;
        runs.push({index:index+1,status:"failed",error:String(error instanceof Error?error.message:error),fixtureError:outcome?.error??null,
          observations,metrics:measured?describe([measured]):null,processResources:outcome?.processResources??null,checks:outcome?.checks??null,fixtureEvidence:fixtureEvidence(outcome),
          fixturePhases:outcome?.fixturePhases??null,nativeWindowEvents:outcome?.nativeWindowEvents??null,environment:environment.evidence});
        throw error;
      } finally {
        await rm(runOutput,{force:true});
        const cleanup=await environment.cleanup();environment=null;
        runs.at(-1).environmentCleanup=cleanup;
        report.summary=describe(runs.filter(run=>run.observations?.performance));
        // Final source/artifact/cleanup gates have not run yet.
        report.status="incomplete";
        await mkdir(dirname(OUTPUT),{recursive:true});
        await writeFile(OUTPUT,JSON.stringify(report,null,2));
      }
    }
  } catch(error) {
    report.status="failed";report.error=String(error instanceof Error?error.message:error);
    throw error;
  } finally {
    if(environment)try {
      report.fallbackEnvironmentCleanup=await environment.cleanup();environment=null;
    } catch(error) {report.status="failed";report.environmentCleanupError=String(error);}
    try {
      report.sourceBinding??={};
      report.sourceBinding.after=await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged=fingerprintsEqual(report.sourceBinding.before,report.sourceBinding.after);
      if(fixture) {
        report.sourceBinding.artifactsAfter=await capturePanelArtifacts(fixture);
        report.sourceBinding.artifactsUnchanged=fingerprintsEqual(report.sourceBinding.artifactsBefore,report.sourceBinding.artifactsAfter);
      }
      if(!report.sourceBinding.sourcesUnchanged || !report.sourceBinding.artifactsUnchanged)report.status="failed";
    } catch(error) {report.status="failed";report.sourceBindingError=String(error);}
    const source={script:join(repositoryRoot,"scripts/benchmark-plugin-panel-native.mjs"),runsCompleted:runs.length};
    report.benchmark=source;
    try {await rm(scratch,{recursive:true,force:true});report.scratchRemoved=true;}
    catch(error) {report.status="failed";report.scratchRemoved=false;report.scratchCleanupError=String(error);}
    report.status=report.status!=="failed" && runs.length===RUNS && runs.every(run=>run.status==="ok")
      && runs.every(run=>run.environmentCleanup?.isolatedEnvironmentRemoved===true)
      && report.sourceBinding?.sourcesUnchanged===true && report.sourceBinding?.artifactsUnchanged===true
      && report.scratchRemoved===true ? "pass" : "failed";
    report.finishedAt=new Date().toISOString();
    await mkdir(dirname(OUTPUT),{recursive:true});
    await writeFile(OUTPUT,JSON.stringify(report,null,2));
  }
  if(report.status!=="pass")throw Error("Native panel measurement or source binding failed; see report");
  console.log(JSON.stringify({output:OUTPUT,status:report.status,summary:report.summary},null,2));
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
