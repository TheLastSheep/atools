((root) => {
 "use strict";
 try {
 const key="__ATOOLS_MAIN_DROP_PROBE__"; if(window[key])return {ok:true,error:null};
 const api=window.ztools, original=api?.updateLaunchContext;
 let context=null,invalidContext=false,writes=0;
 if(typeof original!=="function")return {ok:false,error:"api-unavailable"};
 function normalize(value){
  const files=Array.isArray(value?.pastedFiles)?value.pastedFiles:[];
  const mapped=[];
  for(const file of files){
   if(!file||typeof file.path!=="string"||!file.path.startsWith(root+"/")) {invalidContext=true;return null;}
   const relativePath=file.path.slice(root.length+1);
   if(!["r77-main-drop/file.txt","r77-main-drop/folder"].includes(relativePath)||typeof file.name!=="string"||typeof file.isDirectory!=="boolean") {invalidContext=true;return null;}
   mapped.push({relativePath,name:file.name,isDirectory:file.isDirectory});
  }
  const query=value?.searchQuery;
  if(query!==""&&query!=="ATools Catalog"){invalidContext=true;return null;}
  return {query,files:mapped};
 }
 function wrapper(value){const result=original.apply(this,arguments);const actual=normalize(value);if(actual){context=actual;writes++;}return result;}
 api.updateLaunchContext=wrapper;if(api.updateLaunchContext!==wrapper)return {ok:false,error:"wrapper-rejected"};
 const snapshot=()=>{
  const input=document.querySelector("input.search-input");
  const groups=[...document.querySelectorAll(".pasted-files")];
  const chipNames=[...document.querySelectorAll(".pasted-files .file-name")].map(el=>el.textContent?.trim()??"");
  const count=document.querySelector(".pasted-files .file-count")?.textContent?.trim();
  return {query:input?.value??null,chipNames,chipCount:groups.length,fileCount:count?Number(count):groups.length,
    context,contextWrites:writes,invalidContext};
 };
 const ready=()=>{
  if(!document.querySelector("input.search-input"))return {ok:false,error:"input-missing"};
  if(typeof Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set!=="function")return {ok:false,error:"setter-missing"};
  return {ok:true,error:null};
 };
 const prime=()=>{
  const input=document.querySelector("input.search-input");const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
  if(!input||!setter)return false;
  setter.call(input,"");input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward",data:null}));
  queueMicrotask(()=>{setter.call(input,"ATools Catalog");input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:"ATools Catalog"}));});return true;
 };
 const restore=()=>{
  const input=document.querySelector("input.search-input");if(!input)return false;
  input.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true,cancelable:true}));
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;if(!setter)return false;
  setter.call(input,"ATools Catalog");input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:"ATools Catalog"}));return true;
 };
 Object.defineProperty(window,key,{value:Object.freeze({snapshot,ready,prime,restore}),configurable:false});
 return {ok:true,error:null};
 } catch (_) {return {ok:false,error:"install-exception"};}
})(__ROOT__);
