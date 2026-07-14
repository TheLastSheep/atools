// JSON Viewer plugin - format, validate, and minify JSON

utools.onPluginEnter(({ code, type, payload }) => {
  if (payload && payload.trim()) {
    processJson(payload.trim());
  } else {
    utools.setSubInput({
      placeholder: '粘贴 JSON 字符串进行格式化',
      focus: true
    });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }
  processJson(text.trim());
});

function processJson(text) {
  try {
    const parsed = JSON.parse(text);
    const formatted = JSON.stringify(parsed, null, 2);
    const minified = JSON.stringify(parsed);

    // Count items/keys
    const stats = analyzeJSON(parsed);

    utools.outPlugin({
      items: [
        {
          title: `格式化 JSON (${stats})`,
          description: '点击复制格式化后的 JSON',
          data: formatted
        },
        {
          title: `压缩 JSON (minified)`,
          description: '点击复制压缩后的 JSON',
          data: minified
        }
      ]
    });
  } catch (e) {
    utools.outPlugin({
      items: [
        {
          title: 'JSON 格式错误',
          description: e.message
        }
      ]
    });
  }
}

function analyzeJSON(obj) {
  if (Array.isArray(obj)) {
    return `数组，${obj.length} 项`;
  } else if (typeof obj === 'object' && obj !== null) {
    return `对象，${Object.keys(obj).length} 个键`;
  }
  return typeof obj;
}
