use super::Fixture;

pub(super) const PERMISSION_HOST: &str = r#"<!doctype html><meta charset="utf-8"><title>Native permission interaction smoke</title>
<style>:root{--bg-primary:#f6f7f9;--bg-secondary:#fff;--bg-tertiary:#edf0f4;--bg-elevated:#fff;--bg-hover:#e5eaf1;--text-primary:#1f2328;--text-secondary:#626b78;--text-tertiary:#8a94a3;--border:#ddd;--border-strong:#bbb;--accent:#7c3aed;--accent-hover:#6d28d9;--danger:#d92d20;--warning:#b7791f;--font-sans:system-ui;--font-mono:monospace}body{font:14px system-ui;background:#f6f7f9;color:#1f2328;padding:16px}</style>
<h2>实际授权弹窗 / 隔离临时数据</h2><input id="native-permission-search" placeholder="搜索应用、插件或文件"><div id="permission-root"></div>
<script src="atools-smoke://localhost/permission-ui.js"></script>"#;

pub(super) const HOST: &str = r#"<!doctype html><meta charset="utf-8"><title>Isolated native gate smoke</title>
<h2>ATools isolated Node gate smoke</h2><p>Temporary SQLite and non-persistent WebView. No production data.</p>
<iframe id="plugin" sandbox="allow-scripts" style="width:98%;height:180px;border:1px solid #ccc"></iframe>
<script>
window.addEventListener('message',event=>{
 if(event.source===document.getElementById('plugin').contentWindow && event.data && event.data.nativeGateSmoke) {
  event.data.checks.messageOriginNull=event.origin==='null';
  if(event.origin!=='null')event.data.ok=false;
  fetch('atools-smoke://localhost/report',{method:'POST',body:JSON.stringify(event.data)});
 }
});
fetch('atools-smoke://localhost/report',{method:'POST',body:JSON.stringify({stage:'ready'})});
</script>"#;

pub(super) fn frame(fixture: &Fixture, endpoint: &str) -> String {
    let bridge = fixture
        .bridge
        .replace("__ATOOLS_NATIVE_ENDPOINT__", endpoint);
    let file =
        serde_json::to_string(&fixture.root.join("plugin/data.txt").to_string_lossy()).unwrap();
    let secret = serde_json::to_string(&fixture.secret).unwrap();
    let private_error = serde_json::to_string(&fixture.private_error).unwrap();
    format!(
        r#"<!doctype html><meta charset="utf-8"><p id="status">Running actual Rust gate transport…</p><script>
window.require={bridge};
(async()=>{{
 const checks={{opaqueOrigin:location.origin==='null',noTauri:typeof window.__TAURI_INTERNALS__==='undefined',parentDocumentBlocked:false}},timings={{}};
 try {{ parent.document.body; }} catch(_) {{ checks.parentDocumentBlocked=true; }}
 try {{
  const fs=require('node:fs'),crypto=require('node:crypto');
  let start=performance.now(); checks.fsSync=fs.readFileSync({file},'utf8')==={secret}; timings.firstFsSyncMs=performance.now()-start;
  checks.sha256=crypto.createHash('sha256').update('abc').digest('hex')==='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  checks.fsPromise=await fs.promises.readFile({file},'utf8')==={secret};
  checks.fsCallback=await new Promise((resolve,reject)=>fs.stat({file},(error,stat)=>error?reject(error):resolve(stat.isFile())));
  const server=require('node:http').createServer();
  checks.nodePropertySet=Reflect.set(server,'maxHeadersCount',17)&&server.maxHeadersCount===17;
  const nodeProcess=require('node:process'),version=nodeProcess.version;
  checks.nodeReadonlySet=Reflect.set(nodeProcess,'version','should-not-change')===false&&nodeProcess.version===version;
  try {{ (function(){{'use strict';nodeProcess.version='should-not-change';}})();checks.nodeStrictReadonlySet=false; }} catch(error) {{ checks.nodeStrictReadonlySet=error instanceof TypeError; }}
  try {{ require('./private.cjs').fail(); checks.privateError=false; }} catch(error) {{ checks.privateError=error.message.includes({private_error}); }}
  document.getElementById('status').textContent='Native gate business checks completed';
  parent.postMessage({{nativeGateSmoke:true,ok:Object.values(checks).every(Boolean),checks,timings}},'*');
 }} catch(error) {{ parent.postMessage({{nativeGateSmoke:true,ok:false,checks,error:'Business probe did not complete'}},'*'); }}
}})();</script>"#
    )
}
