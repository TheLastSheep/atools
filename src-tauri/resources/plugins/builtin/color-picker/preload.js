// Color Picker plugin - convert between HEX/RGB/HSL

utools.onPluginEnter(({ code, type, payload }) => {
  if (type === 'regex' && payload) {
    convertColor(payload.trim());
  } else if (payload && payload.trim()) {
    convertColor(payload.trim());
  } else {
    utools.setSubInput({
      placeholder: '输入颜色值 (#fff, #ffffff, rgb(255,255,255), hsl(0,100%,50%))',
      focus: true
    });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }
  convertColor(text.trim());
});

function convertColor(input) {
  try {
    const color = parseColor(input);
    if (!color) {
      utools.outPlugin({ items: [{ title: '无法识别的颜色格式', description: input }] });
      return;
    }

    const hex = rgbToHex(color.r, color.g, color.b);
    const rgb = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const hsl = rgbToHsl(color.r, color.g, color.b);

    utools.outPlugin({
      items: [
        {
          title: `HEX: ${hex}`,
          description: '点击复制',
          data: hex
        },
        {
          title: `RGB: ${rgb}`,
          description: '点击复制',
          data: rgb
        },
        {
          title: `HSL: hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
          description: '点击复制',
          data: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`
        }
      ]
    });
  } catch (e) {
    utools.outPlugin({ items: [{ title: '颜色转换错误', description: e.message }] });
  }
}

function parseColor(input) {
  // HEX (#fff or #ffffff)
  const hexMatch = input.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    return hexToRgb(hexMatch[1]);
  }

  // RGB (rgb(255, 255, 255) or rgb(255,255,255))
  const rgbMatch = input.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (rgbMatch) {
    return { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
  }

  // HSL (hsl(0, 100%, 50%))
  const hslMatch = input.match(/hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/i);
  if (hslMatch) {
    return hslToRgb(parseInt(hslMatch[1]), parseInt(hslMatch[2]), parseInt(hslMatch[3]));
  }

  return null;
}

function hexToRgb(hex) {
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}
