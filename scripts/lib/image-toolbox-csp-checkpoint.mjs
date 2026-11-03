const MESSAGE_KIND = "atools-image-toolbox-child-checkpoint";
const OBSERVER_CODE = "child-csp-observer-installed";
const BLOCKED_CODE = "child-module-lease-script-csp-blocked";
const MODULE_TAG = '<script type="module" src="index.js"></script>';

/** Build a head-time observer that reports only fixed scheme/directive categories. */
export function imageToolboxCspCaptureScript() {
  return `<script>(function(){
  const kind=${JSON.stringify(MESSAGE_KIND)};
  let sentBlocked=false,eventCount=0;
  const maxEvents=32;
  function checkpoint(code){try{window.parent.postMessage({kind,code,observed:true},"*");}catch{}}
  function isPluginLeaseUri(value){
    if(typeof value!=="string")return false;
    try{
      const url=new URL(value);
      const marker=value.indexOf("://");
      if(marker<=0||url.username||url.password||url.port)return false;
      const authorityStart=marker+3;
      let authorityEnd=value.length;
      for(const delimiter of ["/","?","#"]){
        const index=value.indexOf(delimiter,authorityStart);
        if(index>=0&&index<authorityEnd)authorityEnd=index;
      }
      const authority=value.slice(authorityStart,authorityEnd);
      if(url.protocol==="atools-plugin:")return url.hostname==="localhost"&&authority==="localhost";
      return (url.protocol==="http:"||url.protocol==="https:")
        &&url.hostname==="atools-plugin.localhost"&&authority==="atools-plugin.localhost";
    }catch{return false;}
  }
  function onViolation(event){
    if(sentBlocked)return;
    eventCount+=1;
    if((event.effectiveDirective==="script-src"||event.effectiveDirective==="script-src-elem")&&isPluginLeaseUri(event.blockedURI)){
      sentBlocked=true;
      window.removeEventListener("securitypolicyviolation",onViolation);
      checkpoint(${JSON.stringify(BLOCKED_CODE)});
      return;
    }
    if(eventCount>=maxEvents)window.removeEventListener("securitypolicyviolation",onViolation);
  }
  window.addEventListener("securitypolicyviolation",onViolation);
  checkpoint(${JSON.stringify(OBSERVER_CODE)});
})();</script>`;
}

/** Insert immediately after the fixed fixture CSP and before its original module entry. */
export function insertImageToolboxCspCapture(html, csp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (html.split(meta).length !== 2 || html.split(MODULE_TAG).length !== 2) {
    throw new Error("Image-Toolbox fixture CSP or module entry is not unique");
  }
  const metaEnd = html.indexOf(meta) + meta.length;
  const headEnd = html.indexOf("</head>");
  const moduleStart = html.indexOf(MODULE_TAG);
  if (metaEnd <= 0 || headEnd < metaEnd || moduleStart <= headEnd) {
    throw new Error("Image-Toolbox CSP capture insertion point is invalid");
  }
  const script = imageToolboxCspCaptureScript();
  return `${html.slice(0, metaEnd)}\n${script}\n${html.slice(metaEnd)}`;
}
