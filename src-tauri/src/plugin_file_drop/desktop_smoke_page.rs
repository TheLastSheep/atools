//! Minimal private page used only by the opt-in native file-drop fixture.
pub(super) const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Isolated file-drop fixture</title>
<script>
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const send = async (path, value) => fetch(`atools-file-drop-smoke://localhost/${path}`, {
  method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(value)
});
window.fixturePrepare = async p => {
  try {
    const r = await invoke('prepare_plugin_file_drop', {
      pluginId:p.pluginId, instanceId:p.instanceId, intentId:p.intentId,
      pageDocumentId:null, frameGeneration:1, documentNonce:'isolated-fixture-nonce'
    });
    await send('prepared', {requestId:r.requestId, tool:r.tool, runId:r.runId,
      permissionRequired:r.permission_required===true, error:false});
  } catch (_) { await send('prepared', {error:true}); }
};
window.fixtureDeliver = async p => {
  let wrongOwnerRejected=false, secondTakeRejected=false, arrayBuffer=false, exactBytes=false;
  let fileCount=0, totalBytes=0, headerValid=false;
  try {
    await invoke('get_plugin_file_drop_delivery', {
      pluginId:p.pluginId, instanceId:p.wrongInstanceId, requestId:p.requestId
    });
  } catch (_) { wrongOwnerRejected=true; }
  try {
    const packet=await invoke('get_plugin_file_drop_delivery', {
      pluginId:p.pluginId, instanceId:p.instanceId, requestId:p.requestId
    });
    arrayBuffer=packet instanceof ArrayBuffer;
    if (arrayBuffer && packet.byteLength>=9) {
      const bytes=new Uint8Array(packet), view=new DataView(packet);
      const headerLength=view.getUint32(5,true), headerEnd=9+headerLength;
      if (bytes[0]===65 && bytes[1]===84 && bytes[2]===70 && bytes[3]===68 &&
          bytes[4]===1 && headerEnd<=bytes.length) {
        const header=JSON.parse(new TextDecoder().decode(bytes.subarray(9,headerEnd)));
        fileCount=header.files.length; totalBytes=bytes.length-headerEnd;
        headerValid=header.requestId===p.requestId && header.files.length===p.expected.length &&
          header.files.every(file=>file.size<=4*1024*1024) && totalBytes<=8*1024*1024 && fileCount<=16;
        exactBytes=headerValid && header.files.every((file,index)=>{
          const expected=p.expected[index], start=headerEnd+file.offset;
          return file.name===expected.name && file.size===expected.bytes.length &&
            file.offset>=0 && start+file.size<=bytes.length &&
            expected.bytes.every((value,offset)=>bytes[start+offset]===value);
        });
        exactBytes=exactBytes && header.files.reduce((sum,file)=>sum+file.size,0)===totalBytes;
      }
    }
  } catch (_) {}
  try {
    await invoke('get_plugin_file_drop_delivery', {
      pluginId:p.pluginId, instanceId:p.instanceId, requestId:p.requestId
    });
  } catch (_) { secondTakeRejected=true; }
  await send('delivered', {wrongOwnerRejected, secondTakeRejected, arrayBuffer,
    exactBytes, fileCount, totalBytes, headerValid});
};
window.fixtureCancelledPrepare = async p => {
  try {
    const r=await invoke('prepare_plugin_file_drop', {
      pluginId:p.pluginId, instanceId:p.instanceId, intentId:p.intentId,
      pageDocumentId:null, frameGeneration:1, documentNonce:'cancel-fixture-nonce'
    });
    await send('cancel-prepared', {requestId:r.requestId, tool:r.tool, runId:r.runId,
      permissionRequired:r.permission_required===true, error:false});
  } catch (_) { await send('cancel-prepared', {error:true}); }
};
window.fixtureMaxPrepare = async p => {
  try {
    const r = await invoke('prepare_plugin_file_drop', {
      pluginId:p.pluginId, instanceId:p.instanceId, intentId:p.intentId,
      pageDocumentId:null, frameGeneration:1, documentNonce:'max-fixture-nonce'
    });
    await send('max-prepared', {requestId:r.requestId, tool:r.tool, runId:r.runId,
      permissionRequired:r.permission_required===true, error:false});
  } catch (_) { await send('max-prepared', {error:true}); }
};
window.fixtureMaxDeliver = async p => {
  const started = performance.now();
  let arrayBuffer=false, headerValid=false, exactPattern=false, fileCount=0, totalBytes=0;
  try {
    const packet = await invoke('get_plugin_file_drop_delivery', {
      pluginId:p.pluginId, instanceId:p.instanceId, requestId:p.requestId
    });
    arrayBuffer = packet instanceof ArrayBuffer;
    if (arrayBuffer && packet.byteLength >= 9) {
      const bytes = new Uint8Array(packet), view = new DataView(packet);
      const headerLength = view.getUint32(5, true), headerEnd = 9 + headerLength;
      if (bytes[0]===65 && bytes[1]===84 && bytes[2]===70 && bytes[3]===68 &&
          bytes[4]===1 && headerEnd<=bytes.length) {
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, headerEnd)));
        fileCount = header.files.length; totalBytes = bytes.length - headerEnd;
        headerValid = header.requestId===p.requestId && header.files.length===p.expected.length &&
          header.files.every((file,index)=>file.name===p.expected[index].name &&
            file.size===p.expected[index].size && file.offset===p.expected[index].offset) &&
          totalBytes===p.expected.reduce((sum,file)=>sum+file.size,0) &&
          packet.byteLength===headerEnd+totalBytes;
        exactPattern = headerValid;
        if (exactPattern) for (const file of p.expected) {
          const start = headerEnd + file.offset;
          for (let i=0; i<file.size; i++) {
            if (bytes[start+i]!==file.byte) { exactPattern=false; break; }
          }
          if (!exactPattern) break;
        }
      }
    }
  } catch (_) {}
  await send('max-delivered', {arrayBuffer,headerValid,exactPattern,fileCount,totalBytes,
    elapsedMs:Math.round(performance.now()-started)});
};
window.fixtureCloseAndTryDelivery = async p => {
  let closed=false, deliveryRejected=false;
  try { await invoke('close_plugin_file_drop', {pluginId:p.pluginId, instanceId:p.instanceId}); closed=true; } catch (_) {}
  try { await invoke('get_plugin_file_drop_delivery', {
    pluginId:p.pluginId, instanceId:p.instanceId, requestId:p.requestId
  }); } catch (_) { deliveryRejected=true; }
  await send('cancelled', {closed, deliveryRejected});
};
send('ready', {ready:true});
</script>"#;
