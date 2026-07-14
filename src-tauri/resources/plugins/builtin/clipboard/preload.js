// Clipboard plugin - manage clipboard history

const DB_KEY = 'clipboard_history';
const MAX_HISTORY = 50;

utools.onPluginEnter(({ code }) => {
  utools.setSubInput({
    placeholder: '搜索剪贴板历史',
    focus: true
  });

  // Load initial history
  loadHistory();
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    loadHistory();
    return;
  }
  // Filter history by search text
  loadHistory(text);
});

async function onClipboardChange() {
  // Called when clipboard content changes (via Tauri event)
  const newContent = await utools.clipboard.readText();
  if (!newContent) return;

  const history = await getHistory();
  const entry = {
    text: newContent,
    timestamp: Date.now()
  };

  // Add to front, avoiding duplicates
  const filtered = history.filter(item => item.text !== newContent);
  filtered.unshift(entry);

  // Trim to max history
  const trimmed = filtered.slice(0, MAX_HISTORY);

  await utools.db.put({ _id: DB_KEY, items: trimmed });
  loadHistory();
}

async function loadHistory(filter = '') {
  try {
    const history = await getHistory();
    let items = history;

    // Apply filter if provided
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      items = history.filter(item =>
        item.text.toLowerCase().includes(lowerFilter)
      );
    }

    const resultItems = items.map(item => ({
      title: item.text.length > 50 ? item.text.slice(0, 50) + '...' : item.text,
      description: formatTimestamp(item.timestamp),
      data: item.text
    }));

    utools.outPlugin({ items: resultItems });
  } catch (e) {
    console.error('[Clipboard] Failed to load history:', e);
    utools.outPlugin({ items: [] });
  }
}

async function getHistory() {
  try {
    const doc = await utools.db.get(DB_KEY);
    return doc.items || [];
  } catch (e) {
    // Document doesn't exist yet
    return [];
  }
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 1000 / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;

  return date.toLocaleDateString('zh-CN');
}

// Listen for clipboard changes (if Tauri event is available)
if (typeof window !== 'undefined' && window.__TAURI__) {
  window.__TAURI__.event.listen('clipboard-change', () => {
    onClipboardChange();
  });
}
