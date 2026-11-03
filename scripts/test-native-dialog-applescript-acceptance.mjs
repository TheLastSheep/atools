import assert from "node:assert/strict";
import {
  createNativeApplicationCapture,
  FIRST_PANEL_HOLD_MS,
  orchestrateFourPrivateDialogOperations,
  parseAppleScriptAcceptanceOptions,
  validateNativeDialogHelperRecord,
} from "./run-native-dialog-applescript-acceptance.mjs";

assert.equal(FIRST_PANEL_HOLD_MS,15000);
assert.throws(()=>parseAppleScriptAcceptanceOptions([]),/Explicit/);
assert.throws(()=>parseAppleScriptAcceptanceOptions(["--output","/private/tmp/unauthorized.json"]),/Explicit/);
assert.throws(()=>parseAppleScriptAcceptanceOptions(["--authorized-four-private-operations","--authorized-four-private-operations"]));
assert.throws(()=>parseAppleScriptAcceptanceOptions(["--authorized-four-private-operations","--unknown"]));
const paths=parseAppleScriptAcceptanceOptions(["--authorized-four-private-operations","--output","/private/tmp/fresh-control.json"]);
assert.equal(paths.output,"/private/tmp/fresh-control.json");
assert.equal(paths.pageDocument,false);
assert.equal(parseAppleScriptAcceptanceOptions(["--authorized-four-private-operations","--page-document"]).pageDocument,true);
assert.throws(()=>parseAppleScriptAcceptanceOptions(["--authorized-four-private-operations","--page-document","--page-document"]));
assert.throws(()=>parseAppleScriptAcceptanceOptions(["--page-document"]),/Explicit/);
assert.equal(new Set(Object.values(paths)).size,Object.keys(paths).length);

const metadata={status:"starting-real-native-dialog-acceptance",nativeApplication:{executable:"synthetic-unexecuted-binary"},
  treeDirectory:"/private/tmp/atools-fixture-environment-Test01/native-fixture/tree-data",
  savePath:"/private/tmp/atools-fixture-environment-Test01/native-fixture/export-output/tree-data@1x.png"};
const parser=createNativeApplicationCapture();
const stdout='offline compiler message\n{"status":"building"}\n'+JSON.stringify(metadata,null,2)+"\n";
for(let index=0;index<stdout.length;index+=3)parser.feed(stdout.slice(index,index+3));
assert.deepEqual(parser.application,metadata,"Chunked pretty JSON must preserve the first native application identity");
parser.feed(JSON.stringify({...metadata,nativeApplication:{executable:"replacement"}})+"\n");
assert.deepEqual(parser.application,metadata,"Later stdout must never replace the first native application identity");
const finalLine=createNativeApplicationCapture();finalLine.feed(JSON.stringify(metadata));finalLine.end();
assert.deepEqual(finalLine.application,metadata,"A final JSON line without newline is still captured");
for(const input of ["{"+" ".repeat(65536),"{\n"+" ".repeat(65536)+"\n"]) {
  const excessive=createNativeApplicationCapture();excessive.feed(input);assert.ok(excessive.error,"Metadata buffering must stay bounded");
}

const stages=["awaiting-open-cancel","awaiting-open-select","awaiting-save-cancel","awaiting-save-select"];
const expectedActions=[
  [stages[0],"inspect"],[stages[0],"cancel"],
  [stages[1],"inspect"],[stages[1],"goto"],[stages[1],"confirm"],
  [stages[2],"inspect"],[stages[2],"cancel"],
  [stages[3],"inspect"],[stages[3],"goto"],[stages[3],"name"],[stages[3],"confirm"],
];
function scenario(kind="pass") {
  let now=0,index=0;
  const calls=[],records=[],polls=[];
  return {calls,records,polls,get now(){return now;},options:{metadata,now:()=>now,
    isLive:()=>kind!=="dead-child"||now<2000,
    record:async event=>records.push(event),
    sleep:async ms=>{assert.ok(ms>0&&ms<=100,"Each poll must be positive and at most 100ms");polls.push(ms);now+=ms;},
    readCheckpoint:async()=>({...metadata,
      stage:kind==="missing-stage"?"authorizing":kind==="skipped-stage"?stages[1]:stages[index],
      control:"awaiting_root_native_picker_control",
      runtime:{nativeDialogs:kind==="vanished-panel"&&now>=12000?0:1,dialogInvocations:1}}),
    runAction:async(stage,action)=>{
      calls.push({stage,action,atMs:now});
      if(kind==="helper-failure"&&stage===stages[1]&&action==="goto")throw Error("Synthetic helper failed");
      if(kind==="helper-over-deadline")now=111000;
      if(kind!=="stale-stage"&&["cancel","confirm"].includes(action))index++;
    },
  }};
}
const success=scenario();await orchestrateFourPrivateDialogOperations(success.options);
assert.deepEqual(success.calls.map(({stage,action})=>[stage,action]),expectedActions,"Exactly the 11 reviewed control actions must run once in order");
assert.equal(success.calls[0].atMs,15000,"No inspect or cancel is allowed before the real first-panel hold ends");
assert.equal(success.records.find(event=>event.kind==="first-native-panel-held").heldMs,15000);
assert.deepEqual(success.records.filter(event=>event.kind==="stage-ready").map(event=>event.stage),stages);
assert.equal(success.polls.length,150);

for(const [kind,count,error] of [
  ["vanished-panel",0,/Expected live native/],
  ["missing-stage",0,/stage deadline/],
  ["skipped-stage",0,/skipped the required phase/],
  ["dead-child",0,/probe process ended/],
  ["stale-stage",2,/stage deadline/],
  ["helper-failure",4,/Synthetic helper failed/],
  ["helper-over-deadline",1,/deadline exceeded after action/],
]) {
  const failed=scenario(kind);
  await assert.rejects(orchestrateFourPrivateDialogOperations(failed.options),error,kind);
  assert.equal(failed.calls.length,count,"No retry or later operation after "+kind);
  if(kind==="vanished-panel")assert.equal(failed.now,12000,"A panel disappearing during the 15s hold stops immediately");
  if(kind==="helper-failure")assert.equal(failed.calls.at(-1).action,"goto","A failed goto must not confirm or begin save operations");
}

const inspected={stage:stages[1],action:"inspect",pid:123,output:"选择文件夹, Cancel, Open, private fixture target"};
assert.equal(validateNativeDialogHelperRecord(inspected,stages[1],"inspect"),123);
assert.equal(validateNativeDialogHelperRecord({...inspected,stage:stages[3],output:"保存目录树图片, 取消, 保存"},stages[3],"inspect"),123);
assert.equal(validateNativeDialogHelperRecord({...inspected,output:"AXSheet, Cancel, Open"},stages[1],"inspect"),123);
assert.equal(validateNativeDialogHelperRecord({...inspected,stage:stages[3],output:"AXSheet, Cancel, Save"},stages[3],"inspect"),123);
assert.throws(()=>validateNativeDialogHelperRecord({...inspected,stage:stages[3],output:"AXSheet, Cancel, Open"},stages[3],"inspect"));
for(const changed of [{output:"Unknown panel, Cancel, Open"},{output:"选择文件夹, Open"},{output:"选择文件夹, Cancel"},
  {output:"missing value,,"},{output:"AXWindow, Cancel, Open"},{output:"AXSheet, Open"},{output:"AXSheet, Cancel, Save"},
  {pid:0},{pid:1.5},{pid:"123"},{error:"AX failed"},{stage:stages[3]},{action:"confirm"}]) {
  assert.throws(()=>validateNativeDialogHelperRecord({...inspected,...changed},stages[1],"inspect"),"Unknown controls, phase, result or PID must fail");
}
for(const [stage,action,output] of [[stages[0],"cancel","actual-native-cancel-button-clicked"],
  [stages[3],"confirm","actual-native-confirm-button-clicked"]]) {
  assert.equal(validateNativeDialogHelperRecord({...inspected,stage,action,output},stage,action),123);
  assert.throws(()=>validateNativeDialogHelperRecord({...inspected,stage,action,output:"button not clicked"},stage,action));
}
console.log("Native dialog AppleScript orchestration offline checks passed: exact 11 actions, first 15s hold, vanished panel/missing or stale phase/helper failure/dead child stop, strict controls and PID evidence, bounded metadata; no GUI or AppleScript executed");
