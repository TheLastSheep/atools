import assert from "node:assert/strict";
import { reviewedDialogAction } from "./control-native-dialog-acceptance.mjs";
const base={stage:"awaiting-open-select",control:"awaiting_root_native_picker_control",runtime:{nativeDialogs:1,dialogInvocations:1},
  treeDirectory:"/private/tmp/atools-fixture-environment-Test01/native-fixture/tree-data",
  savePath:"/private/tmp/atools-fixture-environment-Test01/native-fixture/export-output/tree-data@1x.png"};
assert.deepEqual(reviewedDialogAction(base,base.stage,"goto"),[base.treeDirectory]);
assert.deepEqual(reviewedDialogAction({...base,stage:"awaiting-save-select"},"awaiting-save-select","name"),["tree-data@1x.png"]);
for(const changed of [{stage:"complete"},{control:"not_ready"},{runtime:{nativeDialogs:0,dialogInvocations:1}},
  {treeDirectory:"/Users/harris/Documents"},{savePath:base.savePath.replace("Test01","Other")},
  {treeDirectory:base.treeDirectory.replace("/native-fixture/","/../native-fixture/")}]) {
  assert.throws(()=>reviewedDialogAction({...base,...changed},base.stage,"goto"));
}
assert.throws(()=>reviewedDialogAction(base,base.stage,"cancel"));
assert.throws(()=>reviewedDialogAction({...base,stage:"awaiting-save-cancel"},"awaiting-save-cancel","confirm"));
console.log("Native OS control scope passed: live exact phase and private targets required; no GUI executed");
