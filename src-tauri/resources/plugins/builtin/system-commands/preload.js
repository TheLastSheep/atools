// System Commands plugin - execute system actions

const COMMANDS = {
  'shutdown': {
    name: '关机',
    description: '关闭计算机',
    dangerous: true,
    action: () => executeMacCommand('osascript -e \'tell app "System Events" to shut down\'')
  },
  'restart': {
    name: '重启',
    description: '重启计算机',
    dangerous: true,
    action: () => executeMacCommand('osascript -e \'tell app "System Events" to restart\'')
  },
  'sleep': {
    name: '休眠',
    description: '使计算机进入睡眠状态',
    dangerous: false,
    action: () => executeMacCommand('pmset sleepnow')
  },
  'lock-screen': {
    name: '锁定屏幕',
    description: '锁定用户屏幕',
    dangerous: false,
    action: () => executeMacCommand('/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend')
  },
  'logout': {
    name: '注销',
    description: '注销当前用户',
    dangerous: true,
    action: () => executeMacCommand('osascript -e \'tell app "System Events" to log out\'')
  },
  'empty-trash': {
    name: '清空废纸篓',
    description: '清空废纸篓中的所有文件',
    dangerous: true,
    action: () => executeMacCommand('osascript -e \'tell app "Finder" to empty trash\'')
  },
  'show-desktop': {
    name: '显示桌面',
    description: '最小化所有窗口',
    dangerous: false,
    action: () => executeMacCommand('osascript -e \'tell app "System Events" to set visible of every process to false\'')
  },
  'screenshot': {
    name: '截图',
    description: '截取屏幕截图',
    dangerous: false,
    action: () => executeMacCommand('screencapture -i -')
  }
};

utools.onPluginEnter(({ code }) => {
  const command = COMMANDS[code];

  if (!command) {
    utools.outPlugin({
      items: [{
        title: '未知命令',
        description: `未找到命令: ${code}`
      }]
    });
    return;
  }

  if (command.dangerous) {
    // Show confirmation dialog
    utools.outPlugin({
      items: [
        {
          title: `确认${command.name}`,
          description: command.description,
          data: code
        },
        {
          title: '取消',
          description: '返回不执行',
          data: 'cancel'
        }
      ]
    });
  } else {
    // Execute immediately
    executeCommand(code);
  }
});

async function executeCommand(code) {
  if (code === 'cancel') {
    utools.outPlugin();
    return;
  }

  const command = COMMANDS[code];
  if (!command) {
    console.error('[SystemCommands] Unknown command:', code);
    return;
  }

  try {
    await command.action();
    utools.showNotification(`${command.name}成功`);
    // Close the plugin after successful execution
    setTimeout(() => utools.outPlugin(), 1000);
  } catch (error) {
    console.error('[SystemCommands] Execution failed:', error);
    utools.outPlugin({
      items: [{
        title: `${command.name}失败`,
        description: error.message
      }]
    });
  }
}

function executeMacCommand(command) {
  // This is macOS-only, but we need shell integration via Tauri
  // For now, log the command that would be executed
  console.log('[SystemCommands] Would execute:', command);

  // In a real Tauri environment, this would call:
  // return window.__TAURI__.shell.execute(command);

  // Stub for now - will be replaced when Tauri shell integration is ready
  return Promise.resolve();
}
