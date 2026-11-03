/** Capture resolved CSS colors as canvas sRGB samples plus every ancestor background layer. */
export function browserContrastSampleExpression(selector) {
  return `(()=>{
    const target=document.querySelector(${JSON.stringify(selector)});
    if(!(target instanceof HTMLElement))throw new Error('Contrast target missing: '+${JSON.stringify(selector)});
    target.scrollIntoView({block:'center',inline:'nearest'});
    const rect=target.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),y=Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2));
    const hit=document.elementFromPoint(x,y);
    if(!(hit===target||target.contains(hit)))throw new Error('Contrast target is obscured: '+${JSON.stringify(selector)});
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const context=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});
    if(!context)throw new Error('Canvas sRGB sampling is unavailable');
    const rgba=color=>{
      if(!CSS.supports('color',color))throw new Error('Unsupported computed CSS color: '+color);
      context.clearRect(0,0,1,1);context.fillStyle='rgba(0,0,0,0)';context.fillStyle=color;context.fillRect(0,0,1,1);
      const data=context.getImageData(0,0,1,1).data;return [data[0]/255,data[1]/255,data[2]/255,data[3]/255];
    };
    const describe=node=>node===document.documentElement?'html':node===document.body?'body':node.tagName.toLowerCase()+(node.id?'#'+node.id:'')+(typeof node.className==='string'&&node.className.trim()?'.'+node.className.trim().split(/\\s+/).join('.'): '');
    const layers=[];
    for(let node=target;node instanceof HTMLElement;node=node.parentElement){
      const style=getComputedStyle(node);layers.push({selector:describe(node),backgroundCss:style.backgroundColor,backgroundRgba:rgba(style.backgroundColor),
        backgroundImage:style.backgroundImage,opacity:Number(style.opacity),mixBlendMode:style.mixBlendMode,filter:style.filter,backdropFilter:style.backdropFilter});
      if(node===document.documentElement)break;
    }
    const foregroundCss=getComputedStyle(target).color;
    return {selector:${JSON.stringify(selector)},foregroundCss,foregroundRgba:rgba(foregroundCss),canvasBackdropCss:'Canvas',canvasBackdropRgba:rgba('Canvas'),layers};
  })()`;
}

function composite(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(index =>
    (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha,
  ).concat(alpha);
}

function luminance(rgb) {
  const channels = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** Composite the actual computed foreground/background stack before applying WCAG relative luminance. */
export function auditBrowserContrastSample(sample) {
  if (!sample || !Array.isArray(sample.foregroundRgba) || !Array.isArray(sample.canvasBackdropRgba)
    || !Array.isArray(sample.layers) || sample.layers.length === 0) {
    throw new TypeError("Invalid browser contrast sample");
  }
  let backdrop = sample.canvasBackdropRgba;
  for (const layer of [...sample.layers].reverse()) {
    if (!Array.isArray(layer.backgroundRgba) || layer.backgroundRgba.length !== 4
      || layer.backgroundImage !== "none" || layer.opacity !== 1 || layer.mixBlendMode !== "normal"
      || layer.filter !== "none" || layer.backdropFilter !== "none") {
      throw new Error(`Unsupported background composition at ${layer.selector}`);
    }
    backdrop = composite(layer.backgroundRgba, backdrop);
  }
  const renderedForeground = composite(sample.foregroundRgba, backdrop);
  const foregroundLuminance = luminance(renderedForeground);
  const backgroundLuminance = luminance(backdrop);
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  return {
    selector: sample.selector,
    foregroundCss: sample.foregroundCss,
    backgroundLayers: [{ selector: "canvas-underlay", backgroundCss: sample.canvasBackdropCss },
      ...sample.layers.map(layer => ({ selector: layer.selector, backgroundCss: layer.backgroundCss }))],
    renderedForeground: renderedForeground.slice(0, 3),
    renderedBackground: backdrop.slice(0, 3),
    ratio,
  };
}

export function maxSrgbChannelDelta(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 3 || right.length !== 3) {
    throw new TypeError("Expected two rendered sRGB triplets");
  }
  return Math.max(...left.map((channel, index) => Math.abs(channel - right[index])));
}
