import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPluginPanelNativeFixture, createPanelFixtureEnvironment, repositoryRoot, runPluginPanelNativeFixture, treeHash } from "./probe-plugin-panel-native.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";

export function parsePageNavigationProbeOptions(argv){
  const values={};let observeNavigation=false;
  for(let index=0;index<argv.length;index++){
    const key=argv[index],value=argv[index+1];
    if(key==="--observe-navigation"&&!observeNavigation){observeNavigation=true;continue;}
    if(!["--output","--checkpoint"].includes(key)||!value||value.startsWith("--")||values[key])
      throw Error("Usage: probe-plugin-page-navigation-native.mjs [--observe-navigation] [--output OUTPUT] [--checkpoint CHECKPOINT]");
    values[key]=value;index++;
  }
  const output=resolve(values["--output"]||join(repositoryRoot,"output/legacy-node-2026-10-15/synthetic-page-navigation-native.json"));
  const checkpoint=resolve(values["--checkpoint"]||output.replace(/\.json$/u,"")+".checkpoint.json");
  if(output===checkpoint)throw Error("Navigation report and dialog-fixture checkpoint must have distinct paths");
  return {output,checkpoint,observeNavigation};
}

/** Only the two import names are reused. Neither community package is copied or executed. */
export async function createPageNavigationSyntheticPlugins(environmentRoot){
  const root=join(environmentRoot,"synthetic-page-navigation-packages");await mkdir(root,{mode:0o700});
  for(const id of ["char-transform","file-tree"]){
    const directory=join(root,id);await mkdir(directory,{mode:0o700});
    const navigation=id==="file-tree";
    const manifest={name:id,title:navigation?"合成导航探针":"合成未使用占位探针",version:"0.0.0-synthetic",
      description:"Generated synthetic pure-Web navigation acceptance fixture; no original community package content",
      author:"ATools synthetic fixture",main:"index.html",permissions:[],
      syntheticFixture:{generated:true,purpose:navigation?"page-document-navigation":"unused-import-placeholder",originalPackageContent:false},
      features:[{code:navigation?"page-navigation":"synthetic-unused",explain:navigation?"合成页面导航探针":"合成未使用占位探针",
        cmds:[navigation?"synthetic page navigation":"synthetic unused placeholder"]}]};
    await writeFile(join(directory,"plugin.json"),JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});
    const html=navigation?`<!doctype html><html><head><meta charset="utf-8"><title>合成导航探针</title></head>
<body><p>Generated synthetic page navigation fixture</p><script>
try {
  window.ztools.dbStorage.setItem('synthetic-page-navigation-roundtrip', 'synthetic-value');
  const value = window.ztools.dbStorage.getItem('synthetic-page-navigation-roundtrip');
  document.documentElement.dataset.syntheticDataRoundtrip = String(value === 'synthetic-value');
  document.documentElement.dataset.syntheticReady = String(value === 'synthetic-value');
} catch (error) { document.documentElement.dataset.syntheticError = String(error && error.message || error).slice(0,200); }
</script></body></html>`:
      "<!doctype html><meta charset=\"utf-8\"><title>合成未使用占位探针</title><p>Synthetic unused import placeholder</p>";
    await writeFile(join(directory,"index.html"),html,{flag:"wx",mode:0o600});
    await writeFile(join(directory,"revoked.html"),"<!doctype html><meta charset=\"utf-8\"><title>合成导航目标</title><p>Synthetic raw navigation target without a host bridge</p>",{flag:"wx",mode:0o600});
  }
  return root;
}

export function validateWorkerPolicyEvidence(proof){
  if(proof?.probes?.length!==3||proof.observationWindowMs!==500||proof.serviceWorkerRegistrationAttempted!==false||proof.networkRequested!==false)
    throw Error("Actual bounded worker policy evidence is incomplete");
  for(const [index,kind] of ["classic","module","shared"].entries()){
    const value=proof.probes[index];
    if(value?.kind!==kind||value.scriptExecuted!==false||value.cleanup?.complete!==true)
      throw Error("A worker script executed or its owned resources were not cleaned");
    if(kind==="shared"&&value.available===false){
      if(value.status!=="unavailable"||value.attempted!==false)throw Error("Unsupported SharedWorker cannot claim CSP blocking");
    } else if(value.available!==true||value.attempted!==true||value.status!=="csp-blocked"
      ||!value.violations?.some(event=>event.effectiveDirective==="worker-src"&&event.blockedUriKind==="blob"))
      throw Error("Worker blocking requires an actual worker-src Blob CSP violation");
  }
  return true;
}

export function validatePageNavigationOutcome(report,{observeNavigation=false}={}){
  const policy=observeNavigation?"observe":"revoke",cases=report?.observations?.cases;
  if(report?.passed!==true||report.policy!==policy||report.pageDocumentMode!==true||report.originalSourcesUnchanged!==true
    ||report.temporaryDataRemoved!==true||report.pageDocumentsAfterCleanup!==0||report.resourceLeasesAfterCleanup!==0
    ||report.dataRuntimeDrained!==true||report.pathRuntimeDrained!==true||report.dialogRuntimeDrained!==true
    ||report.allTaskRunsTerminal!==true||!Array.isArray(cases)||cases.length!==5)
    throw Error("Synthetic navigation, native policy or complete fixture cleanup evidence is incomplete");
  validateWorkerPolicyEvidence(report.observations.workerPolicy);
  if(report.observations.workerPolicy.eventOrigin!==cases[0]?.identity?.origin)throw Error("Worker evidence lacks the actual isolated frame origin");
  const operations=["nav-replace","nav-reload","nav-meta","nav-self-blank","nav-history"];
  const requestedKinds=["raw-asset","bootstrap","raw-asset","about-blank","raw-asset"];
  const seen=new Set();
  for(const [index,value] of cases.entries()){
    const identity=value.identity,initial=value.initialFrame,closed=value.closedRuntime;
    if(value.operation!==operations[index]||value.expectedRequestedKind!==requestedKinds[index]
      ||typeof identity?.pageDocumentSimpleId!=="string"||seen.has(identity.pageDocumentSimpleId)
      ||initial?.eventOrigin!==identity.origin||initial.state?.syntheticDataRoundtrip!==true||initial.state?.noTauri!==true
      ||value.nestedBlank?.state?.nestedBlankProof?.documentWriteRead!==true
      ||value.pendingPermission?.permission!=="clipboard.write"||value.pendingPermission.approved!==false
      ||value.pendingPermission.systemApiInvoked!==false||closed?.pageDocuments!==0||closed?.dataSessions!==0||closed?.dataTransport!==false)
      throw Error("A synthetic navigation case lacks fresh document, real data, nested positive control, pending permission or close evidence");
    seen.add(identity.pageDocumentSimpleId);
    if(!observeNavigation&&!value.nativeEvents?.some(event=>event.matchedPageDocumentId?.replaceAll("-","")===identity.pageDocumentSimpleId
      &&event.requestedKind===requestedKinds[index]&&event.sequence>value.previousSequence
      &&event.activeBefore===true&&event.revoked===true&&event.beforeDelegateForward===true))
      throw Error("A navigation case lacks exact native revoke-before-delegate evidence");
  }
  const native=report.observations.finalNativeSnapshot;
  if(native?.enabled!==true||native.installed!==true||native.policy!==policy||native.droppedEvents!==0
    ||report.nativeRevokeVerified!==!observeNavigation)throw Error("Native navigation observation policy or evidence completeness disagrees");
  return {policy,caseCount:cases.length,nativeRevokeVerified:!observeNavigation};
}

async function main(){
  if(process.platform!=="darwin")throw Error("Synthetic native page navigation fixture is macOS-only");
  const options=parsePageNavigationProbeOptions(process.argv.slice(2));const {output,checkpoint,observeNavigation}=options;
  for(const file of [output,checkpoint]){await mkdir(dirname(file),{recursive:true});if(await stat(file).catch(()=>null))
    throw Error("Preserve existing evidence; select fresh navigation output and checkpoint paths");}
  const runId=randomUUID(),scratch=await mkdtemp("/private/tmp/atools-page-navigation-build-");
  let environment,fixture,outcome,failure,plugins;
  const report={schemaVersion:1,runId,status:"running",createdAt:new Date().toISOString(),checkpoint,
    policy:observeNavigation?"observe":"revoke",scope:"Synthetic pure-Web document navigation through the real App and PluginPanel runner",
    boundaries:["Only generated synthetic packages occupy the runner's char-transform and file-tree import names; original plugin sources are never copied or executed",
      "No Node sidecar, clipboard operation, native open/save panel, OS panel controller or AppleScript is invoked",
      "Real ztools.dbStorage write/read uses its actual one-time data authorization and session",
      "A real unapproved clipboard.write frontend permission is pending before each navigation; no permission is granted and no clipboard method is called",
      "Observe policy records real WK frame differences and cannot prove native revocation; revoke policy requires a matching active document to be revoked synchronously before original delegate forwarding",
      "Nested about:blank write/read is a positive control; navigation targets may be denied or unloaded and are not required to become ready",
      "Classic/module and available shared workers use actual constructors with private Blob scripts; a genuine worker-src violation plus no execution marker is required, with every listener, worker, port, timer and Blob URL cleaned",
      "Selected source/artifact hashes are not a complete compiler closure; the private environment is not an OS sandbox"]};
  try {
    report.sourceBinding={scope:"Selected inputs and generated artifacts",before:await capturePanelSources(repositoryRoot)};
    await writeFile(checkpoint,JSON.stringify({runId,stage:"building-synthetic-navigation",control:"not_waiting_for_native_control"},null,2),{flag:"wx",mode:0o600});
    environment=await createPanelFixtureEnvironment(repositoryRoot);
    Object.assign(environment.env,{ATOOLS_PANEL_DIALOG_ACCEPTANCE:"true",ATOOLS_PANEL_DIALOG_CHECKPOINT:checkpoint,ATOOLS_PAGE_NAVIGATION_ACCEPTANCE:"true"});
    report.environment=environment.evidence;
    plugins=await createPageNavigationSyntheticPlugins(environment.root);
    report.syntheticPackageHashesBefore=Object.fromEntries(await Promise.all(["char-transform","file-tree"].map(async id=>[id,await treeHash(join(plugins,id))])));
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch,{dialogAcceptance:true,pageDocument:true,scenario:"page-navigation",pluginSourcesRoot:plugins});
    report.nativeApplication=fixture.appBundle;report.sourceBinding.artifactsBefore=await capturePanelArtifacts(fixture);
    const nativeOutput=join(environment.root,"native-page-navigation-report.json"),fixtureRoot=join(environment.root,"native-fixture");
    report.privateFixture={sameParentAsHome:true,requiredMode:"0700",path:fixtureRoot};
    try{outcome=await runPluginPanelNativeFixture(fixture,{output:nativeOutput,fixtureRoot,env:environment.env,
      observeNavigation,stdio:"ignore",timeoutMs:210000});}
    catch(error){outcome=error?.panelReport;if(!outcome)try{outcome=JSON.parse(await readFile(nativeOutput,"utf8"));}catch{}throw error;}
    report.validation=validatePageNavigationOutcome(outcome,options);report.status="pass";
  } catch(error){failure=error;report.status="failed";report.error=String(error instanceof Error?error.message:error);}
  finally {
    report.outcome=outcome??null;
    try {
      report.sourceBinding??={};report.sourceBinding.after=await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged=fingerprintsEqual(report.sourceBinding.before,report.sourceBinding.after);
      if(fixture){report.sourceBinding.artifactsAfter=await capturePanelArtifacts(fixture);
        report.sourceBinding.artifactsUnchanged=fingerprintsEqual(report.sourceBinding.artifactsBefore,report.sourceBinding.artifactsAfter);}
      if(plugins){report.syntheticPackageHashesAfter=Object.fromEntries(await Promise.all(["char-transform","file-tree"].map(async id=>[id,await treeHash(join(plugins,id))])));
        report.syntheticPackagesUnchanged=fingerprintsEqual(report.syntheticPackageHashesBefore,report.syntheticPackageHashesAfter);}
      if(!report.sourceBinding.sourcesUnchanged||!report.sourceBinding.artifactsUnchanged||!report.syntheticPackagesUnchanged)report.status="failed";
    } catch(error){report.status="failed";report.sourceBindingError=String(error);}
    if(environment)try{report.environmentCleanup=await environment.cleanup();}catch(error){report.status="failed";report.environmentCleanupError=String(error);}
    try{await rm(scratch,{recursive:true,force:true});report.buildScratchRemoved=true;}catch(error){report.status="failed";report.scratchCleanupError=String(error);}
    if(report.environmentCleanup?.isolatedEnvironmentRemoved!==true)report.status="failed";
    report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  }
  if(failure||report.status!=="pass")throw failure||Error("Synthetic page navigation did not pass; retained report: "+output);
  console.log(JSON.stringify({status:report.status,output,checkpoint,runId,policy:report.policy},null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
