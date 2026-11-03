import assert from "node:assert/strict";
import { parseDialogProbeOptions, validateDialogOutcome } from "./probe-plugin-dialog-native.mjs";
import { validateNativeDialogProbeOutcome } from "./run-native-dialog-applescript-acceptance.mjs";

assert.equal(parseDialogProbeOptions([]).checkpoint.endsWith(".checkpoint.json"),true);
assert.equal(parseDialogProbeOptions([]).pageDocument,false);
assert.equal(parseDialogProbeOptions(["--page-document"]).pageDocument,true);
assert.equal(parseDialogProbeOptions(["--checkpoint","/private/tmp/stage.json","--output","/private/tmp/report.json"]).output,"/private/tmp/report.json");
for(const args of [["--foreground"],["--output"],["--unknown","file"],["--output","a","--output","b"],["--checkpoint","a","--output","a"],
  ["--page-document","--page-document"],["--page-document","true"]])assert.throws(()=>parseDialogProbeOptions(args));
function valid(pageDocumentMode=false){
  const pairs=[["showOpenDialog",true],["showOpenDialog",false],["showSaveDialog",true],["showSaveDialog",false]];
  const matches=["/output/plugin_path","/output/preload_path"].map(field=>({runId:"installed-feature",
    capability:"plugin.feature.file-tree",field,expectedInstallationMetadata:true,
    markers:{fixtureRoot:true,selectedTree:false,saveTarget:false,dialogEndpoint:false}}));
  const privacyScan={complete:true,selectionPrivacyVerified:true,installationMetadataVerified:true,
    truncated:false,queryLimitReached:false,serializationFailed:false,matches};
  const proof={readOnlyEvidence:true,privateHomeGuard:true,privateMarkersAbsent:false,
    selectionPrivacyVerified:true,privacyScan,
    selectionEvidence:pairs.map(([method,canceled])=>({method,canceled,count:canceled?0:1,acceptedPrivateTarget:true})),
    dialogRequests:pairs.map(([method,canceled],index)=>({id:"real-run-"+index,method,canceled,count:canceled?0:1,status:"succeeded",terminal:true})),
    png:{fileCount:1,pngSignature:true,independentDecode:true,boundedBytes:true,actualBytes:400,width:200,height:100}};
  const prePicker={...proof,privateMarkersAbsent:false,dialogRequests:[],selectionEvidence:[],png:{fileCount:0}};
  const report={passed:true,pageDocumentMode,pageDocumentsAfterCleanup:0,dialogRuntimeDrained:true,temporaryDataRemoved:true,originalSourcesUnchanged:true,allTaskRunsTerminal:true,
    selectionPrivacyVerified:true,observations:{prePickerPrivacyEvidence:prePicker,exported:{evidence:proof},
      openCancel:{evidence:{png:{fileCount:0}}},saveCancel:{evidence:{png:{fileCount:0}}}}};
  if(pageDocumentMode) {
    const origin="atools-page://"+"a".repeat(32)+".localhost",state={sourceOrigin:origin,sourceOpaque:false,noTauri:true};
    report.observations.frameDocument={pageDocumentMode:true,sandbox:"allow-scripts allow-same-origin",src:origin+"/"+"b".repeat(32)+"/bootstrap.html",
      srcdocEmpty:true,...state,pageDocuments:1};
    report.observations.initial={...state};report.observations.closedRuntime={pageDocuments:0};
    for(const name of ["openCancel","openSelected","saveCancel","exported"]) {
      report.observations[name]??={};report.observations[name].frame={...state};
    }
  }
  return report;
}
assert.doesNotThrow(()=>validateDialogOutcome(valid()));
for(const mutate of [
  value=>value.passed=false,value=>value.dialogRuntimeDrained=false,value=>value.temporaryDataRemoved=false,
  value=>value.originalSourcesUnchanged=false,value=>value.allTaskRunsTerminal=false,
  value=>value.observations.exported.evidence.privateHomeGuard=false,
  value=>value.observations.exported.evidence.privateMarkersAbsent=true,
  value=>value.selectionPrivacyVerified=false,
  value=>value.observations.exported.evidence.privacyScan.selectionPrivacyVerified=false,
  value=>value.observations.prePickerPrivacyEvidence.privacyScan.queryLimitReached=true,
  value=>value.observations.exported.evidence.privacyScan.serializationFailed=true,
  value=>delete value.observations.exported.evidence.privacyScan.matches[0].expectedInstallationMetadata,
  value=>value.observations.exported.evidence.privacyScan.matches[0].expectedInstallationMetadata=false,
  value=>value.observations.exported.evidence.privacyScan.matches[0].field="/output/path",
  value=>value.observations.exported.evidence.privacyScan.matches[0].capability="plugin.other",
  value=>value.observations.exported.evidence.privacyScan.matches[0].markers.dialogEndpoint=true,
  value=>value.observations.exported.evidence.privacyScan.matches.push({runId:"x",capability:"x",field:"/summary",
    expectedInstallationMetadata:false,markers:{fixtureRoot:false,selectedTree:true,saveTarget:false,dialogEndpoint:false}}),
  value=>value.observations.prePickerPrivacyEvidence.dialogRequests.push({id:"x"}),
  value=>value.observations.prePickerPrivacyEvidence.selectionEvidence.push({method:"showOpenDialog"}),
  value=>value.observations.prePickerPrivacyEvidence.png.fileCount=1,
  value=>value.observations.prePickerPrivacyEvidence.privacyScan.matches.pop(),
  value=>value.observations.exported.evidence.selectionEvidence[1].acceptedPrivateTarget=false,
  value=>value.observations.exported.evidence.selectionEvidence.reverse(),
  value=>value.observations.exported.evidence.dialogRequests.pop(),
  value=>value.observations.exported.evidence.dialogRequests[0].canceled=false,
  value=>value.observations.exported.evidence.dialogRequests[3].status="failed",
  value=>value.observations.exported.evidence.png.independentDecode=false,
  value=>value.observations.exported.evidence.png.actualBytes=8*1024*1024+1,
  value=>value.observations.exported.evidence.png.width=0,
  value=>value.observations.exported.evidence.png.height=4097,
  value=>value.observations.saveCancel.evidence.png.fileCount=1,
]){const invalid=valid();mutate(invalid);assert.throws(()=>validateDialogOutcome(invalid));}
const documentReport=valid(true);
assert.doesNotThrow(()=>validateDialogOutcome(documentReport,{pageDocument:true}));
assert.doesNotThrow(()=>validateNativeDialogProbeOutcome({status:"pass",pageDocument:true,outcome:documentReport},true));
assert.doesNotThrow(()=>validateNativeDialogProbeOutcome({status:"pass",pageDocument:false,outcome:valid()},false));
for(const mutate of [value=>delete value.pageDocumentMode,value=>value.pageDocumentMode=false,value=>value.pageDocumentsAfterCleanup=1,
  value=>delete value.observations.frameDocument,value=>value.observations.frameDocument.pageDocumentMode=false,
  value=>value.observations.frameDocument.sandbox="allow-scripts allow-popups",value=>value.observations.frameDocument.srcdocEmpty=false,
  value=>value.observations.frameDocument.src+="?extra=1",value=>value.observations.frameDocument.sourceOrigin="null",
  value=>value.observations.frameDocument.sourceOpaque=true,value=>value.observations.frameDocument.noTauri=false,
  value=>value.observations.frameDocument.pageDocuments=0,value=>value.observations.closedRuntime.pageDocuments=1,
  value=>delete value.observations.closedRuntime,value=>value.observations.initial.sourceOrigin="null",
  value=>delete value.observations.openSelected.frame,value=>value.observations.exported.frame.noTauri=false]) {
  const invalid=valid(true);mutate(invalid);assert.throws(()=>validateDialogOutcome(invalid,{pageDocument:true}));
}
assert.throws(()=>validateNativeDialogProbeOutcome({status:"pass",pageDocument:false,outcome:documentReport},true));
assert.throws(()=>validateNativeDialogProbeOutcome({status:"pass",pageDocument:true,outcome:valid()},true));
assert.throws(()=>validateNativeDialogProbeOutcome({status:"failed",pageDocument:true,outcome:documentReport},true));
console.log("Real native dialog contract guards passed: default opaque and explicit native document modes, actual isolated origin/frame evidence/live and cleanup counts, exact four picker sequence, privacy, independent bounded PNG and cleanup");
