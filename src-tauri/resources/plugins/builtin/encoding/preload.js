// Encoding plugin - Base64, URL, HTML entities, Unicode, MD5/SHA

const state = { currentCode: '' };

utools.onPluginEnter(({ code, payload }) => {
  state.currentCode = code;
  if (payload && payload.trim()) {
    processInput(payload.trim());
  } else {
    const placeholders = {
      base64: '输入要 Base64 编解码的文本',
      urlencode: '输入要 URL 编解码的文本',
      html: '输入要 HTML 转义的文本',
      md5: '输入要计算 MD5 的文本',
      unicode: '输入要 Unicode 转换的文本'
    };
    utools.setSubInput({ placeholder: placeholders[code] || '输入文本...', focus: true });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }
  processInput(text.trim());
});

function processInput(text) {
  switch (state.currentCode) {
    case 'base64':
      try {
        const encoded = btoa(unescape(encodeURIComponent(text)));
        const decoded = decodeURIComponent(escape(atob(text)));
        utools.outPlugin({
          items: [
            { title: `编码: ${encoded}`, data: encoded },
            { title: `解码: ${decoded}`, data: decoded }
          ]
        });
      } catch (e) {
        utools.outPlugin({ items: [{ title: '编码错误', description: e.message }] });
      }
      break;

    case 'urlencode':
      const urlEncoded = encodeURIComponent(text);
      const urlDecoded = decodeURIComponent(text);
      utools.outPlugin({
        items: [
          { title: `编码: ${urlEncoded}`, data: urlEncoded },
          { title: `解码: ${urlDecoded}`, data: urlDecoded }
        ]
      });
      break;

    case 'html':
      const escaped = text.replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[c]));
      const unescaped = text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, s => ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'"
      }[s]));
      utools.outPlugin({
        items: [
          { title: `转义: ${escaped}`, data: escaped },
          { title: `反转义: ${unescaped}`, data: unescaped }
        ]
      });
      break;

    case 'md5':
      computeMD5(text).then(hash => {
        utools.outPlugin({ items: [{ title: `MD5: ${hash}`, data: hash }] });
      });
      break;

    case 'unicode':
      const unicodeEncoded = [...text].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      const unicodeDecoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      utools.outPlugin({
        items: [
          { title: `Unicode 编码: ${unicodeEncoded}`, data: unicodeEncoded },
          { title: `Unicode 解码: ${unicodeDecoded}`, data: unicodeDecoded }
        ]
      });
      break;
  }
}

async function computeMD5(text) {
  // MD5 not natively supported; fall back to SHA-256 if unavailable
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('MD5', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    // MD5 not supported, use SHA-256
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
