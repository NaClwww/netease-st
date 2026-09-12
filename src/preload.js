'use strict';

// preload：隔离世界。页面主世界发的是 DOM CustomEvent（两边共享 DOM），
// 这里把事件转成 IPC 给主进程，并把主进程的命令转回 DOM 事件。
// 注意：preload 在隔离世界，改不到页面的原型；所以截获音频元素那件事
// 必须由 page-agent.js 在页面世界完成（见设计文档 2.4 / 2.8）。

const { ipcRenderer } = require('electron');

window.addEventListener('zmusic:state', (event) => {
  try {
    ipcRenderer.send('zmusic:state', event.detail);
  } catch (err) {
    // 忽略：主进程可能已退出
  }
});

window.addEventListener('zmusic:ready', () => {
  try {
    ipcRenderer.send('zmusic:ready');
  } catch (err) {}
});

ipcRenderer.on('zmusic:cmd', (_event, cmd) => {
  try {
    window.dispatchEvent(new CustomEvent('zmusic:cmd', { detail: cmd }));
  } catch (err) {}
});
