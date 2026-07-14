// QR Code plugin - generate and recognize QR codes

utools.onPluginEnter(({ code, type, payload }) => {
  if (type === 'img') {
    recognizeQR(payload);
  } else if (payload && payload.trim()) {
    showQR(payload.trim());
  } else {
    utools.setSubInput({
      placeholder: '输入文本或 URL 生成二维码',
      focus: true
    });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }
  showQR(text.trim());
});

function showQR(content) {
  // Use QR server API to generate QR code image
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(content)}`;

  utools.outPlugin({
    items: [
      {
        title: `二维码已生成`,
        description: content.length > 50 ? content.slice(0, 50) + '...' : content,
        icon: qrUrl,
        data: content,
        options: {
          type: 'html',
          height: 360,
          html: `
            <div class="qr-container" style="display: flex; flex-direction: column; align-items: center; padding: 20px;">
              <img src="${qrUrl}" alt="QR Code" style="width: 300px; height: 300px; border: 1px solid var(--border, #333);" />
              <div style="margin-top: 12px; color: var(--text-secondary, #888); font-size: 13px; text-align: center; max-width: 300px; word-break: break-all;">
                ${escapeHtml(content)}
              </div>
            </div>
          `
        }
      }
    ]
  });
}

async function recognizeQR(imgPath) {
  // TODO: implement QR recognition using image path
  utools.outPlugin({
    items: [
      {
        title: 'QR 识别功能暂未实现',
        description: '请使用在线工具识别二维码',
        data: imgPath
      }
    ]
  });
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
