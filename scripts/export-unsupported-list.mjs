import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const dirs = fs.readdirSync(pluginRoot).filter(d => fs.statSync(path.join(pluginRoot, d)).isDirectory());

const unsupportedList = [
  // 1. Missing manifest
  { id: 'codecalc', title: 'codecalc (代码计算器)', type: 'MISSING_MANIFEST', root_cause: '纯源码仓库/Git子模块，未包含 plugin.json 清单' },
  { id: 'ctool', title: 'ctool (常用开发工具箱)', type: 'MISSING_MANIFEST', root_cause: '复杂 Web 工程源码，未包含 plugin.json 清单' },
  { id: 'easy-translate', title: 'easy-translate (简易翻译)', type: 'MISSING_MANIFEST', root_cause: '前端源码仓库，缺少 plugin.json' },
  { id: 'ibox-wallpaper', title: 'ibox-wallpaper (壁纸盒子)', type: 'MISSING_MANIFEST', root_cause: '第三方开源壁纸工程，缺少 ZTools/uTools 清单规范' },
  { id: 'quickcommand', title: 'quickcommand (快捷命令)', type: 'MISSING_MANIFEST', root_cause: '快捷命令引擎源码仓库，需通过其打包脚本生成产物' },
  { id: 'redis-client', title: 'redis-client (Redis客户端)', type: 'MISSING_MANIFEST', root_cause: 'Electron/Vue 源码工程，根目录缺少 plugin.json' },

  // 2. Uncompiled / Requires build
  { id: 'ai-skills-manager', title: 'AI-Skills管理器', type: 'REQUIRES_BUILD', root_cause: 'plugin.json 声明 preload 为 preload.js，但仓库内仅有 TypeScript 源码 (preload.ts / preload.cjs)' },
  { id: 'anywhere', title: 'AI Anywhere', type: 'REQUIRES_BUILD', root_cause: 'Vite 开发态工程，入口指向 /main/index.html，需执行 build-plugin.sh 构建生成静态 HTML' },
  { id: 'deepread', title: 'DeepRead (深读)', type: 'REQUIRES_BUILD', root_cause: 'Vue/Vite 项目，manifest 声明指向 dist/index.html 与 dist/preload/services.js，仓库缺少 dist/ 产物' },
  { id: 'pasteboard-pro', title: 'Paste剪切板 (Monorepo)', type: 'REQUIRES_BUILD', root_cause: '剪切板工程源码，需要运行 build-plugin.sh 打包为独立插件' },
  { id: 'prompt-forge', title: '词匠 (Prompt Forge)', type: 'REQUIRES_BUILD', root_cause: 'React/Vite 项目，manifest 声明指向 dist/index.html，需要执行 npm run build 构建（或解压自带的 .zpx）' }
];

console.log(JSON.stringify(unsupportedList, null, 2));
