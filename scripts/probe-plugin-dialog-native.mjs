import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPluginPanelNativeFixture, createPanelFixtureEnvironment, repositoryRoot, runPluginPanelNativeFixture, treeHash } from "./probe-plugin-panel-native.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";

// --page-document opts into the dedicated native document fixture. Omit it for the existing opaque path.
export const REVIEWED_FILE_TREE_SHA="219451b5ed9294aea0013ca78dfdc95b8528ada9ddac013076f0399544e3b07d";
export function parseDialogProbeOptions(argv) {
  const values={};let pageDocument=false;
  for(let index=0;index<argv.length;index++){
    const key=argv[index],value=argv[index+1];
    if(key==="--page-document"&&!pageDocument){pageDocument=true;continue;}
    if(!["--output","--checkpoint"].includes(key)||!value||value.startsWith("--")||values[key])throw Error("Usage: probe-plugin-dialog-native.mjs [--page-document] [--output OUTPUT] [--checkpoint CHECKPOINT]");
    values[key]=value;index++;
  }
  const output=resolve(values["--output"]||join(repositoryRoot,"output/legacy-node-2026-10-15/published-file-tree-native-dialog.json"));
  const checkpoint=resolve(values["--checkpoint"]||output.replace(/\.json$/u,"")+".checkpoint.json");
  if(output===checkpoint)throw Error("Report and checkpoint must be different paths");
  return {output,checkpoint,pageDocument};
}
const INSTALL_METADATA_FIELDS=new Set(["/output/plugin_path","/output/preload_path"]);
const PRIVACY_MARKERS=["fixtureRoot","selectedTree","saveTarget","dialogEndpoint"];
export function verifySelectionPrivacy(evidence) {
  const scan=evidence?.privacyScan;
  if(scan?.complete!==true||scan.truncated!==false||scan.queryLimitReached!==false||scan.serializationFailed!==false
    ||scan.selectionPrivacyVerified!==true||scan.installationMetadataVerified!==true
    ||evidence.selectionPrivacyVerified!==true||!Array.isArray(scan.matches))
    throw Error("All-TaskRun privacy scan is incomplete, unverified, or exceeded its evidence budget");
  let rootMatches=0;
  const rootFields=new Set();
  for(const match of scan.matches){
    const markers=match?.markers;
    if(typeof match?.expectedInstallationMetadata!=="boolean"||!markers||Object.keys(markers).length!==PRIVACY_MARKERS.length
      ||PRIVACY_MARKERS.some(key=>typeof markers[key]!=="boolean")
      ||!PRIVACY_MARKERS.some(key=>markers[key]===true))throw Error("Privacy scan contains an unknown or malformed marker match");
    if(markers.selectedTree||markers.saveTarget||markers.dialogEndpoint)throw Error("A selected path or dialog endpoint entered TaskRun history");
    if(markers.fixtureRoot){
      rootMatches++;
      if(match.expectedInstallationMetadata!==true||match.capability!=="plugin.feature.file-tree"
        ||!INSTALL_METADATA_FIELDS.has(match.field))throw Error("Fixture root appears outside the two exact file-tree installation metadata fields");
      if(rootFields.has(match.field))throw Error("Duplicate fixture-root installation metadata match");
      rootFields.add(match.field);
    }else if(match.expectedInstallationMetadata===true){
      throw Error("Installation metadata exemption does not identify a fixture-root match");
    }
  }
  if(rootMatches!==2||rootFields.size!==2||![...INSTALL_METADATA_FIELDS].every(field=>rootFields.has(field)))
    throw Error("Privacy scan must identify exactly the two reviewed installation metadata fields");
  if(evidence.privateMarkersAbsent!==(rootMatches===0))throw Error("Legacy privateMarkersAbsent value disagrees with exact fixture-root match count");
  return {verified:true,rootMatchCount:rootMatches};
}
export function validateDialogOutcome(report,{pageDocument}={}) {
  const evidence=report?.observations?.exported?.evidence;
  if(report?.passed!==true||report.dialogRuntimeDrained!==true||report.temporaryDataRemoved!==true
    ||report.originalSourcesUnchanged!==true||report.allTaskRunsTerminal!==true||evidence?.readOnlyEvidence!==true
    ||evidence.privateHomeGuard!==true)throw Error("Real picker acceptance or cleanup evidence is incomplete");
  if(typeof report.pageDocumentMode!=="boolean"||(pageDocument!==undefined&&report.pageDocumentMode!==pageDocument))
    throw Error("Native page document mode differs from the explicitly requested fixture mode");
  if(report.pageDocumentMode) {
    const frame=report.observations.frameDocument;
    const match=typeof frame?.src==="string"&&frame.src.match(/^(atools-page:\/\/[a-f0-9]{32}\.localhost)\/[a-f0-9]{32}\/bootstrap\.html$/);
    if(!match||frame.pageDocumentMode!==true||frame.sandbox!=="allow-scripts allow-same-origin"||frame.srcdocEmpty!==true
      ||frame.sourceOrigin!==match[1]||frame.sourceOpaque!==false||frame.noTauri!==true||frame.pageDocuments!==1
      ||report.observations.closedRuntime?.pageDocuments!==0||report.pageDocumentsAfterCleanup!==0)
      throw Error("Actual native document origin, frame attributes, live count or cleanup evidence is incomplete");
    for(const state of [report.observations.initial,...["openCancel","openSelected","saveCancel","exported"].map(key=>report.observations[key]?.frame)]) {
      if(state?.sourceOrigin!==match[1]||state.sourceOpaque!==false||state.noTauri!==true)
        throw Error("An actual original plugin frame observation is missing its isolated native origin or no-Tauri evidence");
    }
  } else if(report.observations.frameDocument?.pageDocumentMode===true) {
    throw Error("Opaque fixture evidence cannot claim an active native document");
  }
  const privacy=verifySelectionPrivacy(evidence);
  const prePicker=report?.observations?.prePickerPrivacyEvidence;
  if(!prePicker||!Array.isArray(prePicker.dialogRequests)||prePicker.dialogRequests.length!==0
    ||!Array.isArray(prePicker.selectionEvidence)||prePicker.selectionEvidence.length!==0
    ||prePicker.png?.fileCount!==0)throw Error("Pre-picker evidence includes a picker request, selection, or export file");
  verifySelectionPrivacy(prePicker);
  if(report.selectionPrivacyVerified!==true)throw Error("Runner did not record verified selection privacy evidence");
  const expected=[["showOpenDialog",true],["showOpenDialog",false],["showSaveDialog",true],["showSaveDialog",false]];
  if(evidence.selectionEvidence?.length!==4||evidence.dialogRequests?.length!==4)throw Error("Exactly four genuine original UI picker outcomes are required");
  for(const [index,[method,canceled]] of expected.entries()) {
    const selected=evidence.selectionEvidence[index];
    if(selected.method!==method||selected.canceled!==canceled||selected.count!==(canceled?0:1)||selected.acceptedPrivateTarget!==true)throw Error("Native selection evidence differs from the exact reviewed sequence");
    if(evidence.dialogRequests.filter(run=>run.method===method&&run.canceled===canceled&&run.count===(canceled?0:1)&&run.status==="succeeded"&&run.terminal===true).length!==1)throw Error("Real picker TaskRun evidence missing or duplicated");
  }
  const png=evidence.png;
  if(png?.fileCount!==1||png.pngSignature!==true||png.independentDecode!==true||png.boundedBytes!==true
    ||!Number.isInteger(png.actualBytes)||png.actualBytes<=32||png.actualBytes>8*1024*1024
    ||!Number.isInteger(png.width)||png.width<1||png.width>4096||!Number.isInteger(png.height)||png.height<1||png.height>4096)throw Error("Independent original PNG evidence is incomplete");
  for(const key of ["openCancel","saveCancel"])if(report.observations[key]?.evidence?.png?.fileCount!==0)throw Error("Actual picker cancellation did not prove no export file");
  return evidence;
}
async function main(){
  if(process.platform!=="darwin")throw Error("Native dialog acceptance is macOS-only");
  const {output,checkpoint,pageDocument}=parseDialogProbeOptions(process.argv.slice(2));
  for(const file of [output,checkpoint]){await mkdir(dirname(file),{recursive:true});if(await stat(file).catch(()=>null))throw Error("Preserve existing native evidence; choose a fresh output/checkpoint path");}
  const runId=randomUUID(),scratch=await mkdtemp("/private/tmp/atools-dialog-build-");
  let environment,fixture,outcome,failure;
  const report={schemaVersion:1,runId,status:"running",createdAt:new Date().toISOString(),checkpoint,pageDocument,
    scope:"Original file-tree 1.0.5 folder selection and image export with operator-controlled genuine OS open/save panels",
    controls:{checkpointStages:["awaiting-open-cancel","awaiting-open-select","awaiting-save-cancel","awaiting-save-select"],
      action:"Wait for awaiting_root_native_picker_control and the genuine OS panel, then cancel or select only the checkpoint private target. Never choose user directories.",
      nativePanelDeadlineMs:120000,processDeadlineMs:510000},
    boundaries:["Private HOME and fixture ownership are checked before original execution; this is not an OS sandbox",
      "A smoke-only native result constraint rejects non-private selections before original scanning/writing; no plugin/system API, picker result, fs, Date, canvas or original state is replaced",
      "A fixture-only console.error observer retains the latest 12 calls, first 3 arguments and 280 characters per argument in the local report, and forwards every original argument, receiver, return value and exception unchanged. Uncaught/rejection records share the 12-entry/280-character budget; all fixture diagnostics redact the fixture token and node/host/data/dialog bearer endpoints",
      "Each operator action starts one original UI event; native cancellation metadata and independent bounded Rust PNG decoding are required",
      "Only the dedicated Vite acceptance flag disables the usual smoke dialog guard; real prepare/session grants remain required",
      "--page-document additionally opts into the native-smoke-only production document load path; actual fixture mode, isolated origin, empty srcdoc, live document count and complete cleanup must agree. Ordinary runs remain opaque",
      "Full mode requires all four actual operating-system picker outcomes; installation metadata remains in activation history under the separately verified exact-field privacy exception"]};
  try {
    report.originalSourceSha=await treeHash(join(repositoryRoot,"ZTools-plugins/plugins/file-tree"));
    if(report.originalSourceSha!==REVIEWED_FILE_TREE_SHA)throw Error("Original file-tree source no longer matches the reviewed fixture");
    report.sourceBinding={scope:"Selected source inputs and generated artifacts, not complete compiler closure",before:await capturePanelSources(repositoryRoot)};
    await writeFile(checkpoint,JSON.stringify({runId,stage:"building",control:"not_ready"},null,2),{flag:"wx",mode:0o600});
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch,{dialogAcceptance:true,pageDocument});
    report.nativeApplication=fixture.appBundle;
    report.sourceBinding.artifactsBefore=await capturePanelArtifacts(fixture);
    environment=await createPanelFixtureEnvironment(repositoryRoot);
    Object.assign(environment.env,{ATOOLS_PANEL_DIALOG_ACCEPTANCE:"true",ATOOLS_PANEL_DIALOG_CHECKPOINT:checkpoint,ATOOLS_PANEL_FOREGROUND_MODE:"required"});
    report.environment=environment.evidence;
    const fixtureRoot=join(environment.root,"native-fixture");
    console.log(JSON.stringify({status:"starting-real-native-dialog-acceptance",runId,output,checkpoint,pageDocument,
      nativeApplication:fixture.appBundle,
      treeDirectory:join(fixtureRoot,"tree-data"),savePath:join(fixtureRoot,"export-output/tree-data@1x.png")},null,2));
    const nativeOutput=join(environment.root,"native-dialog-report.json");
    try{outcome=await runPluginPanelNativeFixture(fixture,{output:nativeOutput,fixtureRoot,env:environment.env,stdio:"ignore",timeoutMs:510000});}
    catch(error){outcome=error?.panelReport;if(!outcome)try{outcome=JSON.parse(await readFile(nativeOutput,"utf8"));}catch{}throw error;}
    const finalEvidence=outcome?.observations?.exported?.evidence;
    const prePickerEvidence=outcome?.observations?.prePickerPrivacyEvidence;
    const finalPrivacy=verifySelectionPrivacy(finalEvidence);
    verifySelectionPrivacy(prePickerEvidence);
    outcome.selectionPrivacyVerified=true;
    report.selectionPrivacyVerified=true;
    report.selectionPrivacy={rootInstallationMetadataMatchCount:finalPrivacy.rootMatchCount,
      scope:"Only exact file-tree plugin_path and preload_path activation metadata; selected tree/save paths and dialog endpoints must be absent"};
    validateDialogOutcome(outcome,{pageDocument});
    report.status="pass";
  } catch(error){failure=error;report.status="failed";report.error=String(error instanceof Error?error.message:error);}
  finally {
    report.outcome=outcome??null;
    if(environment)try{report.environmentCleanup=await environment.cleanup();}catch(error){report.status="failed";report.cleanupError=String(error);}
    try{
      report.sourceBinding??={};report.sourceBinding.after=await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged=fingerprintsEqual(report.sourceBinding.before,report.sourceBinding.after);
      if(fixture){report.sourceBinding.artifactsAfter=await capturePanelArtifacts(fixture);report.sourceBinding.artifactsUnchanged=fingerprintsEqual(report.sourceBinding.artifactsBefore,report.sourceBinding.artifactsAfter);}
      if(!report.sourceBinding.sourcesUnchanged||!report.sourceBinding.artifactsUnchanged)report.status="failed";
    }catch(error){report.status="failed";report.sourceBindingError=String(error);}
    try{await rm(scratch,{recursive:true,force:true});report.buildScratchRemoved=true;}catch(error){report.status="failed";report.scratchCleanupError=String(error);}
    if(report.environmentCleanup?.isolatedEnvironmentRemoved!==true)report.status="failed";
    report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  }
  if(failure||report.status!=="pass")throw failure||Error("Native dialog acceptance failed; see retained report");
  console.log(JSON.stringify({status:report.status,output,checkpoint,runId},null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
