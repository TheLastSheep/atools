// Timestamp plugin - convert between Unix timestamps and date/time

utools.onPluginEnter(({ code, type, payload }) => {
  if (type === 'regex' && payload) {
    // Direct conversion from regex-matched timestamp
    utools.setSubInput({ placeholder: '', focus: false });
    const result = convertTimestamp(payload);
    utools.outPlugin({ items: [result] });
    return;
  }

  utools.setSubInput({
    placeholder: '输入时间戳 (秒/毫秒) 或日期时间 (YYYY-MM-DD HH:mm:ss)',
    focus: true
  });

  // Show current timestamps as default
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const nowFormatted = formatDate(new Date(now));

  utools.outPlugin({
    items: [
      {
        title: `当前时间戳 (秒): ${nowSec}`,
        description: '点击复制',
        data: String(nowSec)
      },
      {
        title: `当前时间戳 (毫秒): ${now}`,
        description: '点击复制',
        data: String(now)
      },
      {
        title: `当前时间: ${nowFormatted}`,
        description: '点击复制',
        data: nowFormatted
      }
    ]
  });
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }

  const result = convertTimestamp(text.trim());
  if (result) {
    utools.outPlugin({ items: [result] });
  } else {
    utools.outPlugin({
      items: [{
        title: '无法识别的时间格式',
        description: '请输入时间戳或 YYYY-MM-DD HH:mm:ss 格式的日期时间'
      }]
    });
  }
});

function convertTimestamp(input) {
  // Check if input is a numeric timestamp
  if (/^\d{10}$/.test(input)) {
    // Seconds timestamp
    const timestamp = parseInt(input, 10) * 1000;
    const date = new Date(timestamp);
    return {
      title: `${formatDate(date)}`,
      description: `时间戳 (秒): ${input}`,
      data: formatDate(date)
    };
  }

  if (/^\d{13}$/.test(input)) {
    // Milliseconds timestamp
    const timestamp = parseInt(input, 10);
    const date = new Date(timestamp);
    return {
      title: `${formatDate(date)}`,
      description: `时间戳 (毫秒): ${input}`,
      data: formatDate(date)
    };
  }

  // Try parsing as date string
  const date = new Date(input);
  if (isNaN(date.getTime())) {
    return null;
  }

  const timestampSec = Math.floor(date.getTime() / 1000);
  const timestampMs = date.getTime();

  return {
    title: `时间戳 (秒): ${timestampSec}`,
    description: `格式化: ${formatDate(date)}`,
    data: String(timestampSec)
  };
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
