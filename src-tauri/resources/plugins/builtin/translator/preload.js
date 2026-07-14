// Translator plugin - translate text between languages

const state = { targetLang: 'auto' };

utools.onPluginEnter(({ code, type, payload }) => {
  // Set target language based on code
  if (code === 'translate-zh') {
    state.targetLang = 'zh';
  } else if (code === 'translate-en') {
    state.targetLang = 'en';
  } else {
    state.targetLang = 'auto';
  }

  if (payload && payload.trim()) {
    translate(payload.trim());
  } else {
    const langHint = state.targetLang === 'zh' ? '为中文' :
                     state.targetLang === 'en' ? '为英文' : '(自动检测语言)';
    utools.setSubInput({
      placeholder: `输入要翻译的文本 ${langHint}`,
      focus: true
    });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }
  translate(text.trim());
});

async function translate(text) {
  try {
    const result = await callTranslateAPI(text, state.targetLang);
    utools.outPlugin({
      items: [
        {
          title: result.translated,
          description: `${result.sourceLang} → ${result.targetLang}`,
          data: result.translated
        }
      ]
    });
  } catch (e) {
    utools.outPlugin({
      items: [
        {
          title: '翻译失败',
          description: e.message
        }
      ]
    });
  }
}

async function callTranslateAPI(text, targetLang) {
  // Auto-detect source language
  const sourceLang = detectLanguage(text);

  // Determine target language
  let target;
  if (targetLang === 'auto') {
    // If source is Chinese, translate to English; otherwise to Chinese
    target = sourceLang === 'zh' ? 'en' : 'zh';
  } else {
    target = targetLang;
  }

  // Use Google Translate API (free but may be blocked in China)
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  // Parse response: data[0] is array of translation segments
  const translatedSegments = data[0].map(segment => segment[0]);
  const translated = translatedSegments.join('');

  // data[2][0] is the detected source language
  const detectedLang = data[2][0] || sourceLang;

  return {
    sourceLang: detectedLang,
    targetLang: target,
    translated: translated
  };
}

function detectLanguage(text) {
  // Simple heuristic: check for Chinese characters
  const hasChinese = /[一-龥]/.test(text);
  return hasChinese ? 'zh' : 'en';
}
