// Execute the actual embedded installer and callback script, not copies of their logic.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const installer=readFileSync(new URL('./main_drop_probe.js',import.meta.url),'utf8').replace('__ROOT__',JSON.stringify('/private/owned'));
const action=readFileSync(new URL('./main_drop_probe_action.js',import.meta.url),'utf8');
function environment() {
 let input={dispatchEvent(){},value:''};
 class Input{};
 Object.defineProperty(Input.prototype,'value',{configurable:true,set(value){this.value=value;}});
 const context=vm.createContext({window:{},document:{querySelector(){return input;},querySelectorAll(){return [];}},HTMLInputElement:Input,InputEvent:class{},KeyboardEvent:class{},queueMicrotask});
 return {context,setInput(value){input=value;},Input};
}
const normalize=value=>JSON.parse(JSON.stringify(value));
const install=e=>normalize(vm.runInContext(installer,e.context));
const invoke=(e,operation)=>normalize(vm.runInContext(action.replace('__ACTION__',JSON.stringify(operation)),e.context));
const e=environment();
assert.deepEqual(install(e),{ok:false,error:'api-unavailable'});
assert.deepEqual(invoke(e,'prime'),{ok:false,error:'reader-missing'});
let calls=0;e.context.window.ztools={updateLaunchContext(){calls++;}};
assert.deepEqual(install(e),{ok:true,error:null});
const wrapper=e.context.window.ztools.updateLaunchContext;
assert.deepEqual(install(e),{ok:true,error:null});
assert.equal(e.context.window.ztools.updateLaunchContext,wrapper,'idempotent install must not wrap twice');
e.context.window.ztools.updateLaunchContext({searchQuery:'ATools Catalog',pastedFiles:[]});assert.equal(calls,1);
assert.deepEqual(invoke(e,'ready'),{ok:true,error:null});
assert.deepEqual(invoke(e,'prime'),{ok:true,error:null});
await Promise.resolve();
e.setInput(null);assert.deepEqual(invoke(e,'ready'),{ok:false,error:'input-missing'});
assert.deepEqual(invoke(e,'prime'),{ok:false,error:'prime-false'});
e.setInput({dispatchEvent(){throw Error('private runtime detail');}});
assert.deepEqual(invoke(e,'prime'),{ok:false,error:'prime-exception'});
delete e.Input.prototype.value;
assert.deepEqual(invoke(e,'ready'),{ok:false,error:'setter-missing'});
const absent=environment();absent.context.window.__ATOOLS_MAIN_DROP_PROBE__={};
assert.deepEqual(invoke(absent,'prime'),{ok:false,error:'prime-missing'});
const broken=environment();broken.context.window.ztools={get updateLaunchContext(){throw Error('private');}};
assert.deepEqual(install(broken),{ok:false,error:'install-exception'});
console.log('actual QA installer/caller: early API, late install, idempotence, ready, prime false/throw, closed JSON passed');
