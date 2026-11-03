//! Private page: real Tauri invoke and Channel API, fixed synthetic requests only.
pub(super) const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Plugin AI native fixture</title>
<script>
const invoke=(name,args)=>window.__TAURI__.core.invoke(name,args);
const post=async value=>fetch('atools-plugin-ai-smoke://localhost/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
window.addEventListener('error',()=>void post({stage:'page-error',code:'window_error'}));
window.addEventListener('unhandledrejection',()=>void post({stage:'page-error',code:'unhandled_rejection'}));
const owner={pluginId:'isolated-native-ai-fixture',instanceId:'11111111-1111-4111-8111-111111111111',
  pageDocumentId:null,frameGeneration:1,documentNonce:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
const contentOne='c'.repeat(8161), contentFinal='__FIXTURE_FINAL_CONTENT__', reasoning='r'.repeat(8161);
const cases=new Set(['pending_cancel','stream','collect','ack_wait','no_delta']);
let current=null;
function label(event){
  if(event.kind==='terminal') return event.status==='succeeded'?'terminal_succeeded':'terminal_other';
  if(event.delta?.content===contentFinal)return 'content_final';
  if(event.delta?.content&&event.delta?.reasoning_content)return 'combined_delta';
  if(event.delta?.content)return 'content_fragment';
  if(event.delta?.reasoning_content)return 'reasoning_fragment';
  return 'unexpected_delta';
}
void (async()=>{
  try{const result=await invoke('list_plugin_ai_models',owner);
    await post({stage:'initial-models',configured:result.configured===true,count:result.models?.length||0});
  }catch(_){await post({stage:'initial-models',error:true,configured:false,count:0})}
})();
window.fixtureProbeModels=async spec=>{
  try{const result=await invoke('list_plugin_ai_models',owner);
    await post({stage:'model-probe',case:spec.caseName,configured:result.configured===true,count:result.models?.length||0});
  }catch(_){await post({stage:'model-probe',case:spec.caseName,error:true,configured:false,count:0})}
};
window.fixtureSetSettings=async spec=>{
  let changed=false;
  try{const raw=await invoke('get_setting',{key:'settings-general'});await invoke('save_general_settings',{expected:{raw},changes:JSON.parse(spec.value),applyNative:false});changed=true}catch(_){}
  await post({stage:'settings-result',case:spec.caseName,changed});
};
window.fixtureOversize=async()=>{
  let rejected=false,budgetRejected=false,requestBytes=0;
  try{
    const request={messages:[{role:'user',content:'x'.repeat(3*1024*1024+1024)}]};
    requestBytes=new TextEncoder().encode(JSON.stringify(request)).length;
    const result=await invoke('prepare_plugin_ai_request',{...owner,clientRequestId:'33333333-3333-4333-8333-333333333333',
      request,mode:'stream'});
    try{await invoke('cancel_plugin_ai_request',{...owner,requestId:result.requestId})}catch(_){}
  }catch(error){rejected=true;budgetRejected=String(error).includes('3 MiB limit')}
  await post({stage:'oversize-result',rejected,budgetRejected,requestBytes});
};
window.fixtureStart=async spec=>{
  try{
    if(!cases.has(spec.caseName)||!['stream','collect'].includes(spec.mode))throw new Error('bad_case');
    const models=await invoke('list_plugin_ai_models',owner);
    if(!models.configured||models.models.length!==1||models.models[0].id!=='fixture-model')throw new Error('bad_models');
    const prepared=await invoke('prepare_plugin_ai_request',{...owner,clientRequestId:spec.clientRequestId,
      request:{messages:[{role:'user',content:spec.prompt}]},mode:spec.mode});
    const foreignChannel=new window.__TAURI__.core.Channel();
    const foreign={...owner,instanceId:'22222222-2222-4222-8222-222222222222'};
    let foreignExecuteRejected=false,foreignAckRejected=false,foreignCancelRejected=false;
    try{await invoke('execute_plugin_ai_request',{...foreign,requestId:prepared.requestId,onDelta:foreignChannel})}catch(_){foreignExecuteRejected=true}
    try{await invoke('ack_plugin_ai_delta',{...foreign,requestId:prepared.requestId,seq:1})}catch(_){foreignAckRejected=true}
    try{foreignCancelRejected=await invoke('cancel_plugin_ai_request',{...foreign,requestId:prepared.requestId})===false}catch(_){foreignCancelRejected=true}
    current={caseName:spec.caseName,requestId:prepared.requestId,runId:null,mode:spec.mode,labels:[],sequences:[],tail:Promise.resolve(),
      receivedContent:'',receivedReasoning:'',envelopeBytes:[],holdFirst:spec.caseName==='ack_wait',held:false,
      channelCount:0,foreignExecuteRejected,foreignAckRejected,foreignCancelRejected,staleRejected:false};
    const channel=new window.__TAURI__.core.Channel();
    channel.onmessage=event=>{
      current.tail=current.tail.then(async()=>{
        if(!current||event.requestId!==current.requestId)throw new Error('wrong_request');
        const name=label(event);current.labels.push(name);current.sequences.push(event.seq);current.channelCount++;
        current.receivedContent+=event.delta?.content||'';
        current.receivedReasoning+=event.delta?.reasoning_content||'';
        const envelopeBytes=new TextEncoder().encode(JSON.stringify(event)).length;
        current.envelopeBytes.push(envelopeBytes);
        const deltaEvent=event.kind==='delta';
        if(current.holdFirst&&deltaEvent&&!current.held){
          current.held=true;
          await post({stage:'channel',case:current.caseName,seq:event.seq,label:name,acked:false,envelopeBytes,
            hasContent:!!event.delta?.content,hasReasoning:!!event.delta?.reasoning_content});
          await post({stage:'ack-held',case:current.caseName,seq:event.seq});
          return;
        }
        await invoke('ack_plugin_ai_delta',{...owner,requestId:current.requestId,seq:event.seq});
        await post({stage:'channel',case:current.caseName,seq:event.seq,label:name,acked:true,envelopeBytes,
          hasContent:!!event.delta?.content,hasReasoning:!!event.delta?.reasoning_content});
      }).catch(()=>post({stage:'page-error',case:current?.caseName||'unknown',code:'channel_handler'}));
    };
    let staleRejected=false;
    const staleChannel=new window.__TAURI__.core.Channel();
    try{await invoke('execute_plugin_ai_request',{...owner,documentNonce:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      requestId:prepared.requestId,onDelta:staleChannel})}catch(_){staleRejected=true}
    current.staleRejected=staleRejected;
    const pending=await invoke('execute_plugin_ai_request',{...owner,requestId:prepared.requestId,onDelta:channel});
    if(pending.permission_required!==true||typeof pending.runId!=='string')throw new Error('missing_pending_run');
    current.runId=pending.runId;
    await post({stage:'pending',case:spec.caseName,requestId:prepared.requestId,clientRequestId:prepared.clientRequestId,runId:pending.runId,
      permissionRequired:true,foreignExecuteRejected,foreignAckRejected,foreignCancelRejected,staleRejected,model:prepared.model});
  }catch(_){await post({stage:'page-error',case:spec?.caseName||'unknown',code:'start_failed'})}
};
window.fixtureResume=async spec=>{
  if(!current||current.caseName!==spec.caseName||current.requestId!==spec.requestId)return;
  let callSucceeded=false;
  try{
    await invoke('call_agent_tool',{name:spec.tool,arguments:{operation:'execute',requestId:current.requestId},
      clientId:'atools-ui',confirmed:true,runId:spec.runId});
    callSucceeded=true;
  }catch(_){}
  let task=null;
  for(let i=0;i<100;i++){
    try{task=await invoke('get_task_run',{id:spec.runId})}catch(_){}
    if(task&&['succeeded','failed','cancelled','partial'].includes(task.status))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  await current.tail;
  let outputExact=false,outputTaken=false;
  if(current.mode==='collect'&&task?.status==='succeeded'){
    try{
      const result=await invoke('take_plugin_ai_result',{...owner,requestId:current.requestId});
      outputTaken=true;outputExact=result.message?.role==='assistant'
        &&result.message?.content===contentOne+contentFinal&&result.message?.reasoning_content===reasoning;
    }catch(_){}
  }
  const terminalSuffix=current.labels.slice(-2), streamKinds=current.labels.slice(0,-2);
  const sequenceNumbersCorrect=current.sequences.every((seq,index)=>seq===index+1);
  const sequenceCorrect=sequenceNumbersCorrect&&(current.caseName==='stream'
    ?terminalSuffix[0]==='content_final'&&terminalSuffix[1]==='terminal_succeeded'
      &&streamKinds.length>0&&streamKinds.every(name=>['combined_delta','content_fragment','reasoning_fragment'].includes(name))
    :current.caseName==='collect'?JSON.stringify(current.labels)===JSON.stringify(['terminal_succeeded']):true);
  const contentExact=current.receivedContent===contentOne+contentFinal;
  const reasoningExact=current.receivedReasoning===reasoning;
  const finalContentExact=current.receivedContent.endsWith(contentFinal);
  await post({stage:'completed',case:current.caseName,callSucceeded,taskStatus:task?.status||'missing',
    sequenceCorrect,sequences:current.sequences,outputTaken,outputExact,channelCount:current.channelCount,
    contentExact,reasoningExact,finalContentExact,maxEnvelopeBytes:Math.max(0,...current.envelopeBytes),
    foreignRejected:current.foreignRejected,staleRejected:current.staleRejected});
};
window.fixtureCancel=async spec=>{
  if(!current||current.caseName!==spec.caseName||current.requestId!==spec.requestId)return;
  let accepted=false;
  try{accepted=await invoke('cancel_plugin_ai_request',{...owner,requestId:current.requestId})===true}catch(_){}
  let task=null;
  if(current.runId){for(let i=0;i<60;i++){
    try{task=await invoke('get_task_run',{id:current.runId})}catch(_){}
    if(task&&['succeeded','failed','cancelled','partial'].includes(task.status))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }}
  await post({stage:'cancel-result',case:current.caseName,accepted,taskStatus:task?.status||'missing'});
};
window.fixtureChangeSettings=async spec=>{
  let changed=false;
  try{const raw=await invoke('get_setting',{key:'settings-general'});await invoke('save_general_settings',{expected:{raw},changes:JSON.parse(spec.value),applyNative:false});changed=true}catch(_){}
  await post({stage:'settings-result',case:current?.caseName||'unknown',changed});
};
fetch('atools-plugin-ai-smoke://localhost/ready',{method:'POST',body:'ready'});
</script>"#;
