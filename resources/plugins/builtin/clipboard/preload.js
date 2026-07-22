// Rust-backed clipboard plugin. System reads and SQLite history stay in Tauri.

const MAX_HISTORY = 100;

utools.onPluginEnter(async () => {
  utools.setSubInput({
    placeholder: '搜索剪贴板历史',
    focus: true
  });
  await captureCurrentClipboard();
  await loadHistory();
});

utools.onSubInput(async ({ text }) => {
  await loadHistory(text.trim());
});

async function captureCurrentClipboard() {
  try {
    await utools.clipboard.readText();
  } catch (error) {
    console.error('[Clipboard] Failed to capture current text:', error);
  }
}

async function loadHistory(filter = '') {
  try {
    const history = await utools.clipboard.history(filter, MAX_HISTORY);
    const resultItems = history.map(item => ({
      title: item.text.length > 50 ? item.text.slice(0, 50) + '...' : item.text,
      description: `${formatTimestamp(item.last_copied_at)} · 使用 ${item.used_count} 次`,
      data: item.text
    }));
    utools.outPlugin({ items: resultItems });
  } catch (e) {
    console.error('[Clipboard] Failed to load history:', e);
    utools.outPlugin({
      items: [{
        title: '剪贴板历史读取失败',
        description: e.message || String(e)
      }]
    });
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
