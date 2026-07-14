// Hello World 插件 preload.js
// 这个文件运行在 QuickJS 沙箱环境中，可以访问 utools.* API

utools.onPluginEnter(({ code, type, payload }) => {
  console.log('Plugin entered:', code, type, payload);
});

utools.onMainPush(({ code, type, payload }) => {
  return [
    {
      icon: 'logo.png',
      title: 'Hello World',
      data: 'hello'
    },
    {
      icon: 'logo.png',
      title: '你好世界',
      data: 'nihao'
    }
  ];
});

utools.onPluginReady(() => {
  console.log('Plugin ready!');
});
