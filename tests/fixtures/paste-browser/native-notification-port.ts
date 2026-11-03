/** Same-document observation port for window.parent===window in the standalone fixture. */
export function pasteNativeNotificationPortScript(browserWindowId: string) {
  const encodedId = JSON.stringify(browserWindowId);
  return `<script data-atools-fixture-native-notification-port>(function(){
    var state={calls:[],rejected:[],allowedRecordId:null};
    Object.defineProperty(window,'__pasteEditorNativePort',{value:state});
    Object.defineProperty(window,'__pasteEditorWindowId',{value:${encodedId}});
    window.addEventListener('message',function(event){
      var message=event.data;
      if(!message||message.__atools_native_call__!==true)return;
      var args=message.args;
      var messageKeys=Object.keys(message).sort().join(',');
      var keys=args&&typeof args==='object'?Object.keys(args).sort().join(','):'';
      var payload=args&&Array.isArray(args.args)&&args.args.length===1?args.args[0]:null;
      var exact=event.source===window
        &&messageKeys==='__atools_native_call__,args,hostedDocumentNonce,method,reqId'
        &&Number.isSafeInteger(message.reqId)&&message.reqId>0
        &&message.method==='sendToParent'
        &&keys==='args,browserWindowId,channel,windowType'
        &&args.channel==='pasteboard-pro:history-changed'
        &&Array.isArray(payload)&&payload.length===1
        &&payload[0]===state.allowedRecordId
        &&args.windowType==='browserWindow'
        &&args.browserWindowId===window.__pasteEditorWindowId
        &&typeof message.hostedDocumentNonce==='string'
        &&/^[0-9a-f]{32}$/.test(message.hostedDocumentNonce);
      var entry={accepted:exact,method:message.method,args:args,hostedDocumentNonceValid:typeof message.hostedDocumentNonce==='string'&&/^[0-9a-f]{32}$/.test(message.hostedDocumentNonce)};
      (exact?state.calls:state.rejected).push(entry);
      window.__atoolsFixtureNativeCallObserved(JSON.stringify(entry));
      window.postMessage(exact
        ?{__atools_native_response__:true,reqId:message.reqId,result:null}
        :{__atools_native_response__:true,reqId:message.reqId,error:'ERR_ATOOLS_TEST_UNEXPECTED_NATIVE'},'*');
    });
  })();<\/script>`;
}
