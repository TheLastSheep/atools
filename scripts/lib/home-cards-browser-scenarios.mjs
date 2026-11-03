import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOME = ".home-panel";
const ADDRESS = "收货地址智能解析";
const LONG_LABEL = "用于验证超长卡片标题在九列布局中被限制为两行且无障碍名称保持完整的测试样本";
const SHORT_LABEL = "IP";
const MARKDOWN = "打开 Live Markdown 实时预览编辑器（支持大纲、文件树、数学公式、Mermaid 图表与多排版主题）";
const SEARCH = "input[data-atools-search-input=\"true\"]";

export function createHomeCardsScenarios({ page, outputDir, runId, delay }) {
  const checks = [];
  const screenshots = [];

  async function cdp(method, params = {}, timeoutMs = 12000) {
    return page.send(method, params, { timeoutMs });
  }

  async function evaluate(expression, timeoutMs = 12000) {
    const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || "Browser expression failed");
    return response.result.value;
  }

  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(35);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  }

  async function key(value, code = value, virtualKey = 0, modifiers = 0) {
    const params = { key: value, code, windowsVirtualKeyCode: virtualKey, modifiers };
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown", ...params,
      ...(value === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await delay(65);
  }

  async function screenshot(name) {
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = join(outputDir, `${name}-${runId}.png`);
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(file, bytes);
    const evidence = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    screenshots.push(evidence);
    return evidence;
  }

  function measurementExpression() {
    return `(()=>{
      const cards=[...document.querySelectorAll('${HOME} .recent-item-shell')];
      const cardFor=text=>cards.find(card=>card.querySelector('.recent-label')?.textContent.trim()===text)||null;
      const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      const style=element=>element?getComputedStyle(element):null;
      const lines=element=>{
        if(!element)return {lineCount:0,visibleCodePoints:0,totalCodePoints:0,tops:[]};
        const node=element.firstChild,text=node?.textContent||'',box=element.getBoundingClientRect(),range=document.createRange(),tops=new Set();
        let offset=0,visibleCodePoints=0,totalCodePoints=0;
        for(const point of Array.from(text)){
          totalCodePoints+=1;range.setStart(node,offset);range.setEnd(node,offset+point.length);offset+=point.length;
          const visible=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0&&r.top>=box.top-0.5&&r.bottom<=box.bottom+0.5);
          if(visible.length){visibleCodePoints+=1;for(const r of visible)tops.add(Math.round(r.top*10)/10)}
        }
        return {lineCount:tops.size,visibleCodePoints,totalCodePoints,tops:[...tops].sort((a,b)=>a-b)};
      };
      const cardMetrics=text=>{
        const shell=cardFor(text),button=shell?.querySelector('button.recent-item'),icon=shell?.querySelector('.recent-icon'),label=shell?.querySelector('.recent-label'),image=icon?.querySelector('img');
        return {found:Boolean(shell),index:shell?.dataset.homeCommandIndex||null,shell:rect(shell),button:rect(button),icon:rect(icon),image:image?{src:image.currentSrc,origin:new URL(image.currentSrc).origin,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,rect:rect(image)}:null,label:rect(label),iconLabelGap:label&&icon?label.getBoundingClientRect().top-icon.getBoundingClientRect().bottom:null,labelText:label?.textContent.trim()||null,buttonText:button?.textContent.trim()||null,lines:lines(label),buttonStyle:button?{padding:style(button).padding,gap:style(button).gap}:null,labelStyle:label?{height:style(label).height,fontSize:style(label).fontSize,lineHeight:style(label).lineHeight,fontWeight:style(label).fontWeight,lineClamp:style(label).webkitLineClamp,wordBreak:style(label).wordBreak,whiteSpace:style(label).whiteSpace}:null};
      };
      const grids=[...document.querySelectorAll('${HOME} .recent-grid')].map(grid=>{
        const tracks=style(grid).gridTemplateColumns.trim().split(/\\s+/).map(value=>Number.parseFloat(value));
        return {kind:grid.classList.contains('pinned-grid')?'pinned':'recent',count:grid.querySelectorAll(':scope > .recent-item-shell').length,columns:tracks.length,trackWidths:tracks,columnGap:style(grid).columnGap,rowGap:style(grid).rowGap,width:grid.clientWidth,scrollWidth:grid.scrollWidth,clientWidth:grid.clientWidth};
      });
      const region=document.querySelector('.home-command-scroll'),shell=document.querySelector('.shell-frame'),doc=document.scrollingElement;
      const bounds=region?(()=>{const r=region.getBoundingClientRect();return{left:r.left+region.clientLeft,right:r.left+region.clientLeft+region.clientWidth,top:r.top+region.clientTop,bottom:r.top+region.clientTop+region.clientHeight}})():null;
      const cardsInScroll=cards.map(card=>({index:Number(card.dataset.homeCommandIndex),rect:rect(card)}));
      const visibleInScroll=item=>Boolean(bounds&&item&&item.left>=bounds.left-1&&item.right<=bounds.right+1&&item.top>=bounds.top-1&&item.bottom<=bounds.bottom+1);
      const shellRect=rect(shell),regionRect=rect(region);
      return {viewport:{width:innerWidth,height:innerHeight},pageOrigin:location.origin,shell:shellRect,home:rect(document.querySelector('${HOME}')),
        scroll:region?{top:region.scrollTop,scrollHeight:region.scrollHeight,clientHeight:region.clientHeight,rect:regionRect,bounds}:null,
        document:{scrollHeight:doc?.scrollHeight||0,clientHeight:doc?.clientHeight||0,scrollTop:doc?.scrollTop||0},grids,
        renderedCards:cardsInScroll,fullyVisibleCards:cardsInScroll.filter(item=>visibleInScroll(item.rect)).map(item=>item.index),
        addressParser:cardMetrics(${JSON.stringify(ADDRESS)}),syntheticLongLabel:cardMetrics(${JSON.stringify(LONG_LABEL)}),shortLabel:cardMetrics(${JSON.stringify(SHORT_LABEL)}),liveMarkdown:cardMetrics(${JSON.stringify(MARKDOWN)}),
        tooltip:document.querySelector('.home-command-hint')?.textContent.trim()||null,
        horizontalOverflow:[document.documentElement,document.body,shell,region,...grids.map(item=>document.querySelector(item.kind==='pinned'?'.recent-grid.pinned-grid':'.recent-grid:not(.pinned-grid)'))].filter(element=>element&&element.scrollWidth>element.clientWidth+1).length};
    })()`;
  }

  async function measure() { return evaluate(measurementExpression()); }

  async function captureDiagnostics(timeoutMs = 2500) {
    return {
      state: await measure().catch(error => ({ error: String(error) })),
      fixtureSnapshot: await evaluate("window.homeCardsFixture?.snapshot?.()??null", timeoutMs).catch(error => ({ error: String(error) })),
    };
  }

  async function setViewport(width, height, theme) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await waitFor(`innerWidth===${width}&&innerHeight===${height}`);
    await evaluate("Promise.race([Promise.all([...(document.querySelector('.shell-frame')?.getAnimations({subtree:true})||[])].map(animation=>animation.finished.catch(()=>undefined))),new Promise(resolve=>setTimeout(resolve,500))])");
    await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,500))])");
  }

  async function waitForVisualStability(timeoutMs = 3000) {
    const result = await evaluate(`(async()=>{
      const bounded=(promise,ms)=>new Promise(resolve=>{
        const timer=setTimeout(()=>resolve({timedOut:true}),ms);
        Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve({value})},error=>{clearTimeout(timer);resolve({error:String(error)})});
      });
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      const fonts=await bounded(document.fonts?.ready??Promise.resolve(),${timeoutMs});
      if(fonts.timedOut||fonts.error)return{fontsReady:false,reason:fonts.timedOut?'timeout':fonts.error};
      await frame();await frame();
      const root=document.querySelector('.shell-frame'),panel=document.querySelector('.home-panel');
      if(!root||!panel)return{fontsReady:true,missingFrame:!root,missingPanel:!panel};
      const finite=()=>root.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations));
      const animations=finite();
      const finished=await bounded(Promise.all(animations.map(animation=>animation.finished.catch(()=>undefined))),${timeoutMs});
      if(finished.timedOut||finished.error)return{fontsReady:true,animationCount:animations.length,animationsFinished:false,reason:finished.timedOut?'timeout':finished.error};
      await frame();await frame();
      const read=element=>{const style=getComputedStyle(element);return{opacity:Number(style.opacity),transform:style.transform}};
      const frameBefore=read(root),panelBefore=read(panel);
      await frame();await frame();
      const frameAfter=read(root),panelAfter=read(panel);
      const same=(a,b)=>Math.abs(a.opacity-b.opacity)<=0.001&&a.transform===b.transform;
      const activeAnimations=finite().filter(animation=>animation.playState!=='finished'&&animation.playState!=='idle').length;
      return{fontsReady:true,animationCount:animations.length,animationsFinished:activeAnimations===0,activeAnimations,
        frame:{before:frameBefore,after:frameAfter,stable:same(frameBefore,frameAfter)},
        panel:{before:panelBefore,after:panelAfter,stable:same(panelBefore,panelAfter)}};
    })()`);
    assert.equal(result.fontsReady, true, `Fonts should settle before screenshot: ${JSON.stringify(result)}`);
    assert.equal(result.animationsFinished, true, `Finite mount animations should finish before screenshot: ${JSON.stringify(result)}`);
    assert.equal(result.frame?.stable, true, `Shell frame opacity/transform should be stable: ${JSON.stringify(result)}`);
    assert.equal(result.panel?.stable, true, `Home panel opacity/transform should be stable: ${JSON.stringify(result)}`);
    assert.ok(result.frame.after.opacity >= 0.99, `Shell frame should be fully opaque before screenshot: ${JSON.stringify(result.frame)}`);
    assert.ok(result.panel.after.opacity >= 0.99, `Home panel should be fully opaque before screenshot: ${JSON.stringify(result.panel)}`);
    assert.ok(result.frame.after.transform === "none" || result.frame.after.transform === "matrix(1, 0, 0, 1, 0, 0)",
      `Shell frame should return to its resting transform before screenshot: ${JSON.stringify(result.frame)}`);
    assert.ok(result.panel.after.transform === "none" || result.panel.after.transform === "matrix(1, 0, 0, 1, 0, 0)",
      `Home panel should return to its resting transform before screenshot: ${JSON.stringify(result.panel)}`);
    return result;
  }

  async function resetFixture() {
    const point = await evaluate(`(()=>{const r=document.querySelector('.shell-frame')?.getBoundingClientRect(),p={x:innerWidth-2,y:innerHeight-2};return{...p,outside:!r||p.x<r.left||p.x>r.right||p.y<r.top||p.y>r.bottom}})()`);
    if (point.outside) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await delay(45);
    }
    const priorSnapshot = await evaluate("window.homeCardsFixture.snapshot()");
    assert.deepEqual(priorSnapshot.unexpectedCommands, [], "A fixture remount must not erase an earlier unexpected IPC failure");
    assert.equal(await evaluate("window.homeCardsFixture.resetFixture()"), true, "Cards fixture should remount the real App");
    await waitFor("window.homeCardsFixture && document.querySelector('.home-panel .recent-item-shell') && document.querySelector('[data-atools-search-input]')");
  }

  function assertNear(actual, expected, message) {
    assert.equal(typeof actual, "number", `${message}: geometry is missing`);
    assert.ok(Math.abs(actual - expected) < 0.5, `${message}: expected ${expected}px ±0.5, got ${actual}px`);
  }

  async function assertCardContract(state, width, height) {
    const counts=Object.fromEntries(state.grids.map(grid=>[grid.kind,grid.count]));
    assert.deepEqual(counts,{pinned:9,recent:18},"Fixture should display the default 9 pinned and 18 recent commands");
    assert.equal(state.renderedCards.length,27,"All default visible command records must be rendered");
    assert.equal(state.horizontalOverflow,0,"Home cards and shell must not create horizontal overflow");
    assert.ok(state.shell.top>=-0.5&&state.shell.bottom<=height+0.5,`The shell must fit the viewport: ${JSON.stringify(state.shell)}`);
    assert.equal(state.document.scrollTop,0,"The document shell must not move when Home content is scrolled");
    for(const grid of state.grids){
      assertNear(Number.parseFloat(grid.columnGap),0,`${grid.kind} column gap`);
      assertNear(Number.parseFloat(grid.rowGap),0,`${grid.kind} row gap`);
      if(width===800)assert.equal(grid.columns,9,`${grid.kind} should use nine columns at desktop width`);
      else assert.ok(grid.trackWidths.length>=4&&grid.trackWidths.every(track=>track>=64),`${grid.kind} responsive tracks must remain at least 64px: ${JSON.stringify(grid.trackWidths)}`);
    }
    for(const card of state.renderedCards)assertNear(card.rect.height,86,`Home card ${card.index} height`);
    const address=state.addressParser;
    assert.equal(address.found,true,"The real Address Parser sample must be present");
    assertNear(address.shell.height,86,"Address Parser card height");
    assertNear(address.icon.width,32,"Address Parser icon width");
    assertNear(address.icon.height,32,"Address Parser icon height");
    assertNear(address.image.rect.width,32,"Address Parser rendered logo width");
    assertNear(address.image.rect.height,32,"Address Parser rendered logo height");
    assert.ok(address.image.complete&&address.image.naturalWidth>0&&address.image.naturalHeight>0,"Address Parser logo must be the copied real SVG, loaded from the fixture origin");
    assert.equal(address.image.origin,state.pageOrigin,"Original logo must load from the fixture's local origin");
    assertNear(address.buttonStyle.gap.endsWith("px")?Number.parseFloat(address.buttonStyle.gap):NaN,6,"Card icon/title gap");
    assertNear(address.iconLabelGap,6,"Icon and title boxes must have the configured non-overlapping gap");
    assert.deepEqual(address.buttonStyle.padding.split(" ").map(Number.parseFloat),[8,4],"Card padding must remain 8px 4px");
    assertNear(address.label.height,32,"Card label frame height");
    assert.equal(address.labelStyle.fontSize,"12px");
    assert.equal(address.labelStyle.lineHeight,"16px");
    assert.equal(address.labelStyle.fontWeight,"500");
    assert.equal(address.labelStyle.lineClamp,"2");
    assert.equal(address.labelStyle.wordBreak,"break-all");
    assert.equal(address.lines.lineCount,2,"The eight-character Address Parser title must wrap into two measured text lines");
    assert.equal(address.lines.visibleCodePoints,8,"Every Address Parser title character must be visible across those two lines");
    const long=state.syntheticLongLabel;
    assert.equal(long.lines.lineCount,2,"The long synthetic title should occupy two visible text lines");
    assert.ok(long.lines.visibleCodePoints<long.lines.totalCodePoints,"The long title should clamp its visible text while retaining its full accessible name");
    const markdown=state.liveMarkdown;
    assert.equal(markdown.found,true,"Live Markdown feature must appear in recent commands");
    assert.equal(markdown.labelText,MARKDOWN,"Live Markdown card label must be the original feature explain text");
    assert.equal(markdown.lines.lineCount,2,"The original Harris Live Markdown label must clamp to two measured lines");
    assert.ok(markdown.lines.visibleCodePoints<markdown.lines.totalCodePoints,"Live Markdown label should visibly clamp while preserving full source text");
    if(height===600&&width===800)assert.ok(state.scroll.scrollHeight<=state.scroll.clientHeight+1,"All 9 pinned and 18 recent commands should fit the 800×600 Home content without inner scrolling");
    if(height===300)assert.ok(state.scroll.scrollHeight>state.scroll.clientHeight,"The short viewport should scroll inside Home while the shell stays fixed");
  }

  async function accessibleNameForLabel(label) {
    const index=await evaluate(`(()=>{const card=[...document.querySelectorAll('.home-panel .recent-item-shell')].find(item=>item.querySelector('.recent-label')?.textContent.trim()===${JSON.stringify(label)});return card?.dataset.homeCommandIndex??null})()`);
    assert.ok(index!==null,`Cannot find accessible name sample ${label}`);
    await cdp("DOM.enable");
    const document=await cdp("DOM.getDocument",{depth:-1,pierce:true});
    const result=await cdp("DOM.querySelector",{nodeId:document.root.nodeId,selector:`.home-panel [data-home-command-index="${index}"] button.recent-item`});
    assert.ok(result.nodeId,`Cannot resolve card button for accessible name: ${label}`);
    const tree=await cdp("Accessibility.getPartialAXTree",{nodeId:result.nodeId,fetchRelatives:false});
    const node=tree.nodes.find(item=>item.role?.value==="button");
    return node?.name?.value??null;
  }

  async function clickSearch() {
    const point=await evaluate(`(()=>{const element=document.querySelector('${SEARCH}');if(!element)return null;const r=element.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight}})()`);
    assert.ok(point?.visible,`Search input must be a visible real keyboard entry point: ${JSON.stringify(point)}`);
    await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
    await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:point.x,y:point.y});
    await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:point.x,y:point.y});
    await delay(55);
  }

  async function clickSelector(selector) {
    const point=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{x:r.left+r.width/2,y:r.top+r.height/2,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,hitTarget:Boolean(hit&&(hit===element||element.contains(hit))),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}}})()`);
    assert.ok(point?.visible&&point.hitTarget,`Real CDP click target must be visible and receive hit testing: ${selector}: ${JSON.stringify(point)}`);
    await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
    await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:point.x,y:point.y});
    await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:point.x,y:point.y});
    await delay(80);
  }

  async function scrollHomeToTop() {
    const point=await evaluate("(()=>{const region=document.querySelector('.home-command-scroll');if(!region)return null;const r=region.getBoundingClientRect();return{x:r.left+region.clientLeft+region.clientWidth/2,y:r.top+region.clientTop+Math.min(region.clientHeight/2,Math.max(1,innerHeight-2)),top:region.scrollTop}})()");
    assert.ok(point,"Home scrollport should exist before header interaction");
    if(point.top>0){
      await cdp("Input.dispatchMouseEvent",{type:"mouseWheel",x:point.x,y:point.y,deltaX:0,deltaY:-1200});
      await waitFor("document.querySelector('.home-command-scroll')?.scrollTop===0",3000);
    }
  }

  async function keyboardRows() {
    return evaluate(`(()=>[...document.querySelectorAll('${HOME} .recent-grid')].map(grid=>{
      const columns=getComputedStyle(grid).gridTemplateColumns.trim().split(/\\s+/).length;
      const items=[...grid.querySelectorAll(':scope > .recent-item-shell')].map(item=>Number(item.dataset.homeCommandIndex));
      const rows=[];for(let start=0;start<items.length;start+=columns)rows.push(items.slice(start,start+columns));
      return{columns,rows};
    }))()`);
  }

  async function activeIndex() {
    return evaluate("Number(document.activeElement?.closest('[data-home-command-index]')?.dataset.homeCommandIndex??-1)");
  }

  async function navigateFocusedCard(targetIndex) {
    const layout=await keyboardRows(),rows=layout.flatMap(section=>section.rows);
    const locate=new Map(rows.flatMap((row,rowIndex)=>row.map((index,column)=>[index,{rowIndex,column}])));
    const start=await activeIndex();
    assert.ok(locate.has(start)&&locate.has(targetIndex),`Keyboard navigation targets must be rendered cards: ${JSON.stringify({start,targetIndex,rows})}`);
    const queue=[start],previous=new Map([[start,null]]);
    for(let cursor=0;cursor<queue.length&&!previous.has(targetIndex);cursor+=1){
      const index=queue[cursor],position=locate.get(index),row=rows[position.rowIndex],above=rows[position.rowIndex-1],below=rows[position.rowIndex+1];
      const next=[row[position.column-1],row[position.column+1],above?.[Math.min(position.column,above.length-1)],below?.[Math.min(position.column,below.length-1)]];
      for(const candidate of next)if(Number.isInteger(candidate)&&!previous.has(candidate)){previous.set(candidate,index);queue.push(candidate)}
    }
    assert.ok(previous.has(targetIndex),`Actual CSS columns have no keyboard route to ${targetIndex}`);
    const path=[];for(let index=targetIndex;index!==start;index=previous.get(index))path.push(index);path.reverse();
    let current=start;
    for(const next of path){
      const from=locate.get(current),to=locate.get(next);
      const direction=from.rowIndex===to.rowIndex?(to.column<from.column?"ArrowLeft":"ArrowRight"):(to.rowIndex<from.rowIndex?"ArrowUp":"ArrowDown");
      const vk={ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40}[direction];
      await key(direction,direction,vk);
      await waitFor(`Number(document.activeElement?.closest('[data-home-command-index]')?.dataset.homeCommandIndex)===${next}`,3000);
      current=next;
    }
    return {start,targetIndex,path,columns:layout.map(section=>section.columns)};
  }

  async function focusCardFromSearch(label) {
    await clickSearch();
    await key("Tab","Tab",9);
    const selected=await activeIndex();
    assert.ok(selected>=0,"Tab from Search should focus the selected Home card");
    const target=await evaluate(`(()=>[...document.querySelectorAll('${HOME} .recent-item-shell')].find(card=>card.querySelector('.recent-label')?.textContent.trim()===${JSON.stringify(label)})?.dataset.homeCommandIndex??null)()`);
    assert.ok(target!==null,`Cannot find keyboard navigation target ${label}`);
    const navigation=await navigateFocusedCard(Number(target));
    return {navigation,target:Number(target),active:await activeIndex()};
  }

  async function cardPoint(label) {
    const point=await evaluate(`(()=>{const card=[...document.querySelectorAll('${HOME} .recent-item-shell')].find(item=>item.querySelector('.recent-label')?.textContent.trim()===${JSON.stringify(label)}),button=card?.querySelector('button.recent-item');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,visible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,index:card.dataset.homeCommandIndex}})()`);
    assert.ok(point?.visible,`Card ${label} must be visible before pointer interaction: ${JSON.stringify(point)}`);
    return point;
  }

  async function verifyKeyboardScrollTooltipAndRemove() {
    const before=await measure();
    const first=await focusCardFromSearch(ADDRESS);
    assert.equal(first.active,Number(first.target),"Real Tab should enter the selected first Home card");
    const firstBounds=await evaluate(`(()=>{const card=document.activeElement?.closest('[data-home-command-index]'),region=document.querySelector('.home-command-scroll');if(!card||!region)return null;const r=card.getBoundingClientRect(),s=region.getBoundingClientRect(),b={left:s.left+region.clientLeft,right:s.left+region.clientLeft+region.clientWidth,top:s.top+region.clientTop,bottom:s.top+region.clientTop+region.clientHeight};return{visible:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1,rect:{top:r.top,bottom:r.bottom}}})()`);
    assert.equal(firstBounds?.visible,true,"First keyboard-reachable card should be fully visible in the inner Home scrollport");
    const lastIndex=await evaluate(`Math.max(...[...document.querySelectorAll('${HOME} .recent-item-shell')].map(item=>Number(item.dataset.homeCommandIndex)))`);
    const lastPath=await navigateFocusedCard(lastIndex);
    const last=await evaluate(`(()=>{const card=document.activeElement?.closest('[data-home-command-index]'),region=document.querySelector('.home-command-scroll'),shell=document.querySelector('.shell-frame'),doc=document.scrollingElement;if(!card||!region||!shell)return null;const r=card.getBoundingClientRect(),s=region.getBoundingClientRect(),b={left:s.left+region.clientLeft,right:s.left+region.clientLeft+region.clientWidth,top:s.top+region.clientTop,bottom:s.top+region.clientTop+region.clientHeight},f=shell.getBoundingClientRect();return{index:Number(card.dataset.homeCommandIndex),visible:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1,innerScrollTop:region.scrollTop,documentScrollTop:doc?.scrollTop||0,shell:{x:f.x,y:f.y,width:f.width,height:f.height}}})()`);
    assert.equal(last?.index,lastIndex,"Keyboard navigation should reach the actual last rendered Home card");
    assert.equal(last?.visible,true,"Last keyboard target should be fully visible within Home's inner scrollport");
    assert.ok(last.innerScrollTop>0,"Short viewport navigation should scroll the inner Home region");
    assert.equal(last.documentScrollTop,before.document.scrollTop,"Inner scrolling must not move the document shell");
    for(const dimension of ["x","y","width","height"])assert.ok(Math.abs(last.shell[dimension]-before.shell[dimension])<1,`Shell ${dimension} should stay fixed while inner content scrolls`);

    const focusedMarkdown=await focusCardFromSearch(MARKDOWN);
    assert.equal(focusedMarkdown.active,focusedMarkdown.target,"Keyboard navigation should focus the original Live Markdown card");
    await waitFor(`document.querySelector('.home-command-hint')?.textContent.trim()===${JSON.stringify(MARKDOWN)}`);
    await clickSearch();
    await waitFor("!document.querySelector('.home-command-hint')");
    const markdownPoint=await cardPoint(MARKDOWN);
    await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:markdownPoint.x,y:markdownPoint.y});
    await waitFor(`document.querySelector('.home-command-hint')?.textContent.trim()===${JSON.stringify(MARKDOWN)}`);
    checks.push({kind:"live-markdown-hover-hint",label:MARKDOWN,pluginName:"Live Markdown",sourceFeatureCode:"typora-workbench"});

    const sourceCodes=await evaluate("window.homeCardsFixture.snapshot().historyCodes");
    assert.equal(sourceCodes.length,24,"The history fixture should begin with exactly 24 fixed records");
    await clickSearch();
    await key("Tab","Tab",9);
    const focusedAfterTab=await activeIndex();
    assert.equal(focusedAfterTab,Number(markdownPoint.index),"Tab should return to the hovered selected Live Markdown card");
    await key("F10","F10",121,8);
    await waitFor("document.querySelector('.launcher-action-menu[role=menu]')");
    const menu=await evaluate(`(()=>{const menu=document.querySelector('.launcher-action-menu[role=menu]');return menu?{text:menu.innerText,items:[...menu.querySelectorAll('[role^=menuitem]')].map(item=>item.textContent.trim()),focus:document.activeElement?.textContent.trim()||null}:null})()`);
    assert.deepEqual(menu.items,["固定到首页","从最近使用移除"],"Shift+F10 should open the real two-action history menu");
    await key("ArrowDown","ArrowDown",40);
    const removeFocused=await evaluate("document.activeElement?.textContent.trim()||null");
    assert.equal(removeFocused,"从最近使用移除","ArrowDown should reach the actual remove menu action");
    await key("Enter","Enter",13);
    await waitFor("window.homeCardsFixture.snapshot().historyCodes.length===23");
    const after=await evaluate("window.homeCardsFixture.snapshot()");
    assert.deepEqual(after.historyUpdateEvents.length,1,"Removing one history card should dispatch one history update callback");
    assert.deepEqual(sourceCodes.filter(code=>!after.historyCodes.includes(code)),["live-markdown:typora-workbench"],"The callback should remove only the selected Live Markdown record");
    assert.deepEqual(after.activationCalls,[],"Context-menu removal must not activate a plugin");
    checks.push({kind:"history-action-menu-remove-once",before:sourceCodes.length,after:after.historyCodes.length,historyUpdateEvents:after.historyUpdateEvents.length,removed:"live-markdown:typora-workbench",menu});

    await cdp("Input.dispatchMouseEvent",{type:"mouseWheel",x:Math.max(2,Math.floor(before.scroll.rect.left+before.scroll.rect.width/2)),y:Math.max(2,Math.floor(before.scroll.rect.top+before.scroll.rect.height/2)),deltaX:0,deltaY:-1200});
    await waitFor("document.querySelector('.home-command-scroll')?.scrollTop===0",3000);
    const addressPoint=await cardPoint(ADDRESS);
    await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:addressPoint.x,y:addressPoint.y});
    await waitFor(`document.querySelector('.home-command-hint')?.textContent.trim()===${JSON.stringify("收货地址智能解析")}`);
    checks.push({kind:"tooltip-open-before-owned-unmount",text:"收货地址智能解析"});
    return {first,last,lastPath,focusedMarkdown,menu,historyUpdateEvents:after.historyUpdateEvents.length,removed:sourceCodes.filter(code=>!after.historyCodes.includes(code))};
  }

  async function verifyResizeFailureNotice() {
    await scrollHomeToTop();
    const selector='.home-panel button[aria-controls="atools-home-pinned-commands"]';
    const before=await evaluate(`(()=>{const shell=document.querySelector('.shell-frame').getBoundingClientRect(),button=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{shell:{x:shell.x,y:shell.y,width:shell.width,height:shell.height},header:{top:button.top,bottom:button.bottom,expanded:document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')}}})()`);
    const callCountBefore=(await evaluate("window.homeCardsFixture.snapshot().resizeCalls.length"));
    assert.equal(await evaluate("window.homeCardsFixture.failNextResize()"),true,"Fixture should arm exactly one controlled resize failure");
    await clickSelector(selector);
    await waitFor("document.querySelector('.home-panel button[aria-controls=\"atools-home-pinned-commands\"]')?.getAttribute('aria-expanded')==='true'");
    await waitFor("window.homeCardsFixture.snapshot().resizeFailureCount===1");
    await waitFor("document.querySelector('.window-resize-notice [role=alert]')");
    const notice=await evaluate(`(()=>{const alert=document.querySelector('.window-resize-notice [role=alert]'),notice=alert?.closest('.window-resize-notice'),close=notice?.querySelector('button[aria-label="关闭窗口大小调整提示"]'),header=document.querySelector(${JSON.stringify(selector)}),shell=document.querySelector('.shell-frame'),a=alert?.getBoundingClientRect(),c=close?.getBoundingClientRect(),s=shell?.getBoundingClientRect();return{role:alert?.getAttribute('role')||null,title:alert?.querySelector('strong')?.textContent.trim()||null,text:alert?.textContent.trim()||null,rawCauseVisible:Boolean(notice?.textContent.includes('private-fixture-resize-cause')),closeLabel:close?.getAttribute('aria-label')||null,closeVisible:Boolean(c&&c.width>0&&c.height>0&&c.left>=0&&c.right<=innerWidth&&c.top>=0&&c.bottom<=innerHeight),alertRect:a?{left:a.left,right:a.right,top:a.top,bottom:a.bottom}:null,focusedHeader:document.activeElement===header,headerExpanded:header?.getAttribute('aria-expanded'),shell:s?{x:s.x,y:s.y,width:s.width,height:s.height}:null}})()`);
    assert.equal(notice.role,"alert");
    assert.equal(notice.title,"窗口大小调整失败");
    assert.equal(notice.rawCauseVisible,false,"The UI notice must not expose the controlled IPC error cause");
    assert.equal(notice.closeLabel,"关闭窗口大小调整提示");
    assert.equal(notice.closeVisible,true,"Notice close action must remain within the current viewport");
    assert.equal(notice.focusedHeader,true,"The failed resize must leave focus on the expanded header");
    assert.equal(notice.headerExpanded,"true");
    for(const dimension of ["x","y","width","height"])assert.ok(Math.abs(notice.shell[dimension]-before.shell[dimension])<1,`Fixed resize notice must not push the shell ${dimension}`);
    const failure=await evaluate("window.homeCardsFixture.snapshot().resizeFailures[0]");
    assert.deepEqual(failure,{args:{height:failure.args.height},error:"private-fixture-resize-cause"});
    assert.ok(Number.isFinite(failure.args.height)&&failure.args.height>0,"Rejected resize should record the actual finite height request");

    await clickSelector('button[aria-label="关闭窗口大小调整提示"]');
    await waitFor("!document.querySelector('.window-resize-notice [role=alert]')");
    let successfulCalls=callCountBefore+1;
    await clickSelector(selector);
    await waitFor(`document.querySelector('.home-panel button[aria-controls="atools-home-pinned-commands"]')?.getAttribute('aria-expanded')==='false'&&window.homeCardsFixture.snapshot().resizeCalls.length===${successfulCalls+1}`);
    assert.equal(await evaluate("Boolean(document.querySelector('.window-resize-notice [role=alert]'))"),false,"The next successful collapse should leave no resize notice");
    successfulCalls+=1;
    await clickSelector(selector);
    await waitFor(`document.querySelector('.home-panel button[aria-controls="atools-home-pinned-commands"]')?.getAttribute('aria-expanded')==='true'&&window.homeCardsFixture.snapshot().resizeCalls.length===${successfulCalls+1}`);
    successfulCalls+=1;
    await clickSelector(selector);
    await waitFor(`document.querySelector('.home-panel button[aria-controls="atools-home-pinned-commands"]')?.getAttribute('aria-expanded')==='false'&&window.homeCardsFixture.snapshot().resizeCalls.length===${successfulCalls+1}`);
    assert.equal(await evaluate("Boolean(document.querySelector('.window-resize-notice [role=alert]'))"),false,"Normal expand/collapse should finish without an alert");
    const snapshot=await evaluate("window.homeCardsFixture.snapshot()");
    assert.equal(snapshot.resizeFailureCount,1,"Only the armed request should reject");
    assert.equal(snapshot.rejectNextResize,false,"The one-shot fixture failure must be consumed");
    checks.push({kind:"controlled-resize-failure-notice",failureSource:"fixtureIPCRejection",rejectedRequest:failure,notice,successfulCalls:snapshot.resizeCalls.slice(callCountBefore+1)});
    return {notice,resizeFailureCount:snapshot.resizeFailureCount,resizeCalls:snapshot.resizeCalls.length,successfulRecoveryCalls:snapshot.resizeCalls.length-callCountBefore-1};
  }

  async function run() {
    const matrix=[{width:800,height:600,theme:"light"},{width:800,height:600,theme:"dark"},{width:420,height:600,theme:"light"},{width:420,height:600,theme:"dark"}];
    for(const item of matrix){
      await setViewport(item.width,item.height,item.theme);
      await resetFixture();
      await waitFor("(()=>{const image=document.querySelector('.home-panel .pinned-grid .recent-item-shell .recent-icon img');return Boolean(image?.complete&&image.naturalWidth>0)})()",5000);
      const visualStability=await waitForVisualStability();
      const shot=await screenshot(`home-cards-${item.width}-${item.theme}`);
      const state=await measure();
      const check={kind:"home-card-visual-contract",...item,screenshot:shot.file,visualStability,measurement:state};
      checks.push(check);
      await assertCardContract(state,item.width,item.height);
      if(item.width===800&&item.theme==="light"){
        assert.equal(await accessibleNameForLabel(ADDRESS),ADDRESS,"Address Parser button accessible name must retain all eight source characters");
        assert.equal(await accessibleNameForLabel(LONG_LABEL),LONG_LABEL,"Long title button accessible name must retain its complete text");
        assert.equal(await accessibleNameForLabel(MARKDOWN),MARKDOWN,"Live Markdown accessible name must equal the full manifest feature explain");
        check.accessibleNames={addressParser:ADDRESS,syntheticLong:LONG_LABEL,liveMarkdown:MARKDOWN};
      }
    }
    await setViewport(800,300,"light");
    await waitFor("document.querySelector('.home-panel .recent-item-shell')");
    const smallViewportStability=await waitForVisualStability();
    const smallShot=await screenshot("home-cards-800x300-light");
    const small=await measure();
    checks.push({kind:"short-viewport-inner-scroll",width:800,height:300,theme:"light",screenshot:smallShot.file,visualStability:smallViewportStability,measurement:small});
    await assertCardContract(small,800,300);
    const resizeFailure=await verifyResizeFailureNotice();
    const interaction=await verifyKeyboardScrollTooltipAndRemove();
    return {matrix:matrix.concat([{width:800,height:300,theme:"light"}]),resizeFailure,interaction};
  }

  return { waitFor, evaluate, run, captureDiagnostics, getSnapshot: () => ({ checks, screenshots }) };
}
