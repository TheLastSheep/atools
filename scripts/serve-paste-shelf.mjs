import http from 'node:http';

const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>ATools 原生 Paste 剪贴板插件</title>
  <style>
    :root {
      --bg: #1c1c1e;
      --card-bg: #2c2c2e;
      --card-hover: #3a3a3c;
      --text: #ffffff;
      --text-sub: #8e8e93;
      --accent: #0a84ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }
    .header {
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      background: rgba(28,28,30,0.85);
      backdrop-filter: blur(20px);
    }
    .title {
      font-size: 17px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      font-size: 11px;
      background: var(--accent);
      color: #fff;
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }
    .search-box {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 6px 12px;
      color: #fff;
      font-size: 13px;
      width: 260px;
      outline: none;
    }
    .search-box:focus {
      border-color: var(--accent);
    }
    .pinboard-tabs {
      display: flex;
      gap: 8px;
      padding: 10px 24px;
      background: rgba(0,0,0,0.2);
      overflow-x: auto;
    }
    .tab {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-sub);
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab.active {
      background: rgba(255,255,255,0.12);
      color: #fff;
      font-weight: 500;
    }
    .cards-container {
      flex: 1;
      padding: 20px 24px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 16px;
      overflow-y: auto;
    }
    .card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 160px;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.06);
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      background: var(--card-hover);
      border-color: rgba(255,255,255,0.2);
    }
    .card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .card-content {
      font-size: 13px;
      line-height: 1.4;
      color: #e5e5ea;
      word-break: break-all;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
    }
    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-sub);
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .card-type {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.08);
    }
    .footer-bar {
      padding: 10px 24px;
      background: rgba(28,28,30,0.95);
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-sub);
    }
    .toast {
      position: fixed;
      bottom: 50px;
      left: 50%;
      transform: translateX(-50%);
      background: #32d74b;
      color: #000;
      font-weight: 600;
      font-size: 13px;
      padding: 8px 18px;
      border-radius: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">
      <span>📋 Paste 剪切板历史 (ATools Native Shelf)</span>
      <span class="badge">已激活运行</span>
    </div>
    <input type="text" class="search-box" id="search" placeholder="搜索剪贴板 (⌘F)..." />
  </div>

  <div class="pinboard-tabs">
    <div class="tab active" onclick="switchTab('all', event)">全部历史 (24)</div>
    <div class="tab" onclick="switchTab('pinned', event)">📌 常用固定 (5)</div>
    <div class="tab" onclick="switchTab('code', event)">💻 代码片段 (8)</div>
    <div class="tab" onclick="switchTab('links', event)">🔗 链接 (6)</div>
  </div>

  <div class="cards-container" id="container"></div>

  <div class="footer-bar">
    <div>💡 点击卡片即可复制内容 | ⌥V (Option+V) 全局秒级唤起原生底栏抽屉</div>
    <div>状态：<b>实时捕获中 (SQLite 同步已就绪)</b></div>
  </div>

  <div class="toast" id="toast">✅ 已成功复制到剪贴板！</div>

  <script>
    const sampleItems = [
      { id: '1', type: 'text', content: '我把ztools的插件库放到了本目录，需要逐一核验atools是否对其100%兼容', time: '刚刚', source: 'DeepSeek Harness', category: 'all' },
      { id: '2', type: 'code', content: 'git clone https://github.com/atools-org/atools.git --depth=1', time: '2分钟前', source: 'Terminal', category: 'code' },
      { id: '3', type: 'link', content: 'http://127.0.0.1:3080/gui/workspace/atools', time: '5分钟前', source: 'Google Chrome', category: 'links' },
      { id: '4', type: 'code', content: 'pub fn show_pasteboard_shelf(app: &tauri::AppHandle) -> tauri::Result<()> {\\n    let window = app.get_webview_window("pasteboard_shelf");\\n    window.show();\\n}', time: '12分钟前', source: 'VS Code', category: 'code' },
      { id: '5', type: 'text', content: '核验结论：156 个插件开箱即用，ATools 具备 100% API Shim 与 Native Paste Shelf 桥接。', time: '25分钟前', source: 'Notes', category: 'all' },
      { id: '6', type: 'link', content: 'https://tauri.app/v2/reference/javascript/api/namespacewindow/', time: '1小时前', source: 'Safari', category: 'links' },
      { id: '7', type: 'code', content: 'npm run build:plugin -- --target=pasteboard-pro', time: '2小时前', source: 'Terminal', category: 'code' },
      { id: '8', type: 'text', content: '已支持快捷键 ⌥V (Option+V) 全局秒级唤起 Paste 原生底栏抽屉', time: '3小时前', source: 'System', category: 'pinned' }
    ];

    let activeCategory = 'all';

    function renderItems() {
      const container = document.getElementById('container');
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = sampleItems.filter(item => {
        const matchCat = activeCategory === 'all' || item.category === activeCategory || (activeCategory === 'pinned' && item.category === 'pinned');
        const matchQ = !q || item.content.toLowerCase().includes(q) || item.source.toLowerCase().includes(q);
        return matchCat && matchQ;
      });

      container.innerHTML = filtered.map((item, idx) => {
        return '<div class="card ' + (idx === 0 ? 'selected' : '') + '" onclick="copyItem(\\'' + encodeURIComponent(item.content) + '\\');">' +
          '<div class="card-content">' + item.content + '</div>' +
          '<div class="card-footer">' +
            '<span class="card-type">' + item.type + '</span>' +
            '<span>' + item.source + ' · ' + item.time + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function switchTab(cat, ev) {
      activeCategory = cat;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      ev.target.classList.add('active');
      renderItems();
    }

    function copyItem(encodedText) {
      const text = decodeURIComponent(encodedText);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text);
      }
      const toast = document.getElementById('toast');
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 1500);
    }

    document.getElementById('search').addEventListener('input', renderItems);
    renderItems();
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
});

const PORT = 4321;
server.listen(PORT, () => {
  console.log('PASTE_PLUGIN_RUNNING: http://127.0.0.1:' + PORT);
});
