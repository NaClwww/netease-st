'use strict';

// 托盘（StatusNotifierItem）。niri/Wayland 下依赖 libayatana-appindicator。
// 创建失败不致命：退化为「仅 MPRIS」，符合设计文档的降级策略。

const { Tray, Menu, nativeImage } = require('electron');

function create({ iconPath, onToggleWindow, onCommand, onQuit }) {
  let tray;
  try {
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = nativeImage.createEmpty();
    tray = new Tray(image);
  } catch (err) {
    console.warn('[tray] 创建失败（niri 下可能需要 libayatana-appindicator3）:', err.message);
    return null;
  }

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: () => onToggleWindow() },
    { type: 'separator' },
    { label: '播放 / 暂停', click: () => onCommand('playpause') },
    { label: '上一首', click: () => onCommand('previous') },
    { label: '下一首', click: () => onCommand('next') },
    { type: 'separator' },
    { label: '退出', click: () => onQuit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip('网易云音乐');
  tray.on('click', () => onToggleWindow());

  return {
    tray,
    setTooltip(text) {
      try { tray.setToolTip(text || '网易云音乐'); } catch (err) {}
    },
    destroy() {
      try { tray.destroy(); } catch (err) {}
    },
  };
}

module.exports = { create };
