// Fixture-only, installed by the native runner into generated iframe content.
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_NAVIGATION_TOKEN__";
  function state() {
    return { text: document.body?.innerText || "", buttons: [...document.querySelectorAll("button")].map(node => node.id) };
  }
  window.addEventListener("message", event => {
    const message=event.data;
    if(event.source!==window.parent||message?.kind!=="atools-navigation-probe"||message.token!==token)return;
    const respond=(error="")=>window.parent.postMessage({kind:"atools-navigation-probe-result",token,id:message.id,error,state:state()},"*");
    try {
      if(message.operation==="escape") {
        respond();
        (document.activeElement||document.body).dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
        return;
      }
      if(message.operation==="keydown") {
        (document.activeElement||document.body).dispatchEvent(new KeyboardEvent("keydown",{key:String(message.key||""),bubbles:true,cancelable:true}));
      } else if(message.operation==="click") {
        const button=document.getElementById(String(message.button||""));
        if(!(button instanceof HTMLButtonElement))throw Error("Missing fixture button");
        button.click();
      } else if(message.operation!=="state") throw Error("Unsupported fixture probe operation");
      setTimeout(()=>respond(),30);
    }catch(error){respond(String(error?.message||error));}
  });
})();
