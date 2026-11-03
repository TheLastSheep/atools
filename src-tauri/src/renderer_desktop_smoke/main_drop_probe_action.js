((action)=>{
 "use strict";
 try {
  const reader=window.__ATOOLS_MAIN_DROP_PROBE__;
  if(action==="observe")return reader?.snapshot?.()??null;
  if(!reader)return {ok:false,error:"reader-missing"};
  if(typeof reader.prime!=="function")return {ok:false,error:"prime-missing"};
  if(action==="ready")return reader.ready();
  const method=action==="prime"?reader.prime:reader.restore;
  return method()===true?{ok:true,error:null}:{ok:false,error:action+"-false"};
 } catch (_) {
  return action==="observe"?null:{ok:false,error:action+"-exception"};
 }
})(__ACTION__);
