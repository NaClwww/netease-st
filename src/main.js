'use strict';

const { app, BrowserWindow, Menu, ipcMain, session, shell, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const mprisFactory = require('./mpris');
const trayFactory = require('./tray');

const APP_NAME = 'netease-st';
const WM_CLASS = 'netease-st';
const SMOKE = !!process.env.NETEASE_ST_SMOKE;
const SMOKE_MS = Number(process.env.NETEASE_ST_SMOKE_MS || 15000);
// 测试用：窗口不显示（但不跳过单实例锁），便于验证单实例行为而不弹窗。
const HIDDEN = !!process.env.NETEASE_ST_HIDDEN;

const cfg = config.load();
const target = config.parseTarget(cfg.url);

const smokeStats = { stateCount: 0, loadCount: 0, agentReady: false, tray: false, mpris: null, errors: [] };

// 兜底：Electron 的主进程未捕获异常会直接弹一个模态错误框，把应用卡死。
// 这类异常可能发生在事件回调里，try/catch 抓不到，只能在这里兜住 ——
// 记录并继续，别让远程页面把整个应用弄挂。
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常（已忽略，避免崩溃弹窗）:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝:', reason && reason.stack ? reason.stack : reason);
});

// ---------------------------------------------------------------------------
// Linux / Wayland 开关：必须在 app.whenReady() 之前
// ---------------------------------------------------------------------------
app.setName(APP_NAME);
// 让 niri / DMS 把窗口与 .desktop 的 StartupWMClass 对上，图标才正确。
app.commandLine.appendSwitch('class', WM_CLASS);
if (cfg.waylandNative) {
  // 原生 Wayland（而非 XWayland）；托盘与输入法在 niri 下更稳。
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
if (cfg.waylandDecorations) {
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}
if (cfg.disableGpu) {
  app.disableHardwareAcceleration();
}

/** 剥离 Electron 标识，伪装成普通 Chrome；避免站点按 UA 拒绝。 */
function chromeLikeUA() {
  const appToken = APP_NAME.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return app.userAgentFallback
    .replace(/\s*Electron\/[^\s]+/g, '')
    .replace(new RegExp(`\\s*${appToken}\\/[^\\s]+`, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// page-agent 注入
//
// 走 CDP 的 Page.addScriptToEvaluateOnNewDocument：在页面脚本执行前注入主世界。
// **不拦截、不改写任何网络请求。**
//
// 为什么不用 protocol.handle('https') 改写壳 HTML：那个 API 是全有或全无的，
// 注册后每个 https 请求都得自己转发一遍，于是：
//   1) 透传只传 URL 会把 POST 降级成无 body 的 GET —— 登录二维码就是这么被我搞挂的；
//   2) 转发时重建 Headers 会因页面送来的非 Latin-1 请求头触发 undici 的
//      ByteString 异常，且发生在事件回调里，直接打崩主进程。
// CDP 注入没有这些问题，也不给页面留下 navigator.webdriver 指纹（实测 false）。
// ---------------------------------------------------------------------------
const PAGE_AGENT = fs.readFileSync(path.join(__dirname, 'page-agent.js'), 'utf8');

async function installPageAgent(win) {
  const dbg = win.webContents.debugger;

  const apply = async () => {
    await dbg.sendCommand('Page.enable');
    return dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_AGENT });
  };

  try {
    dbg.attach('1.3');
    await apply();
  } catch (err) {
    console.warn('[inject] CDP 注入失败，桌面集成可能拿不到播放状态:', err.message);
    return;
  }

  // 调试器断开（例如用户打开 DevTools）后重挂，否则后续导航不会再注入。
  dbg.on('detach', () => {
    if (quitting) return;
    try {
      dbg.attach('1.3');
      apply().catch(() => {});
    } catch (err) {}
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let win = null;
let trayHandle = null;
let mprisHandle = null;
let quitting = false;
let state = { status: 'Stopped', positionMs: 0, durationMs: 0, volume: 1, track: {} };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false, // 先隐藏：等 CDP 注入装好、目标页加载完再显示，避免白屏闪烁
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口隐藏/最小化后，进度与元数据还要继续上报给 MPRIS。
      backgroundThrottling: false,
    },
  });

  if (cfg.stripElectronUA) {
    win.webContents.setUserAgent(chromeLikeUA());
  }

  win.webContents.on('did-start-loading', () => { smokeStats.loadCount++; });

  win.webContents.on('did-finish-load', () => {
    applyZoom();
    applyUserCss();
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED，正常的重定向/取消
    console.warn('[main] 加载失败:', code, desc, url);
    if (url && url !== 'file://' && !url.startsWith('file://')) {
      win.loadFile(path.join(__dirname, 'assets', 'offline.html'), { query: { target: cfg.url } })
        .catch(() => {});
    }
  });

  // 外链：站内放行，站外交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  // 关窗进托盘；托盘「退出」才真退（Linux 上关窗继续放歌是常规预期）。
  win.on('close', (event) => {
    if (quitting || !cfg.closeToTray || !trayHandle) return;
    event.preventDefault();
    win.hide();
  });

  void bootstrapWindow();
}

/**
 * 先给渲染进程一个空文档，CDP 命令才有目标（否则 Page.enable 永远不返回）；
 * 装好注入后再导航到目标页，页面脚本一跑就能被 page-agent 截获。
 */
async function bootstrapWindow() {
  try {
    await win.loadURL('about:blank');
    await installPageAgent(win);
    await win.loadURL(cfg.url);
  } catch (err) {
    smokeStats.errors.push('bootstrap: ' + err.message);
  } finally {
    if (!SMOKE && !HIDDEN && !(cfg.startMinimized && cfg.tray)) showWindow();
  }
}

function isInternal(url) {
  try {
    const u = new URL(url);
    return u.hostname === target.host || u.hostname.endsWith('.music.163.com');
  } catch {
    return false;
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (HIDDEN) return;
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function applyZoom() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.setZoomFactor(Number(cfg.zoom) || 1); } catch (err) {}
}

function applyUserCss() {
  if (!cfg.userCss || !win || win.isDestroyed()) return;
  const file = config.userCssFile();
  const inject = () => {
    try {
      if (!fs.existsSync(file)) return;
      const css = fs.readFileSync(file, 'utf8');
      if (!css.trim()) return;
      win.webContents.insertCSS(css);
    } catch (err) {
      console.warn('[main] 注入 user.css 失败:', err.message);
    }
  };
  inject();
  try {
    fs.watchFile(file, { interval: 2000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) inject();
    });
  } catch (err) {}
}

// ---------------------------------------------------------------------------
// 命令通道：媒体键走 Chromium 原生输入管线（不依赖任何 DOM 选择器）
// ---------------------------------------------------------------------------
const MEDIA_KEY = {
  play: 'MediaPlayPause',
  pause: 'MediaPlayPause',
  playpause: 'MediaPlayPause',
  next: 'MediaNextTrack',
  previous: 'MediaPreviousTrack',
  stop: 'MediaStop',
};

function sendMediaKey(action) {
  const keyCode = MEDIA_KEY[action];
  if (!keyCode || !win || win.isDestroyed()) return false;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  return true;
}

function sendPageCommand(action, value) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('zmusic:cmd', { action, value });
}

function onCommand(action, value) {
  switch (action) {
    case 'play':
      if (state.status !== 'Playing') sendMediaKey('playpause');
      break;
    case 'pause':
      if (state.status === 'Playing') sendMediaKey('playpause');
      break;
    case 'playpause':
      sendMediaKey('playpause');
      break;
    case 'next':
    case 'previous':
    case 'stop':
      sendMediaKey(action);
      break;
    case 'seekTo':
    case 'seekBy':
    case 'volume':
      // 媒体键覆盖不到，直接控制音频元素。
      sendPageCommand(action, value);
      break;
    case 'raise':
      showWindow();
      break;
    case 'quit':
      quitApp();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 状态回传 → MPRIS / 托盘
// ---------------------------------------------------------------------------
function tooltipFor(s) {
  if (!s.track || !s.track.title) return '网易云音乐';
  return `${s.track.title}${s.track.artist ? ' - ' + s.track.artist : ''}`;
}

ipcMain.on('zmusic:ready', () => {
  smokeStats.agentReady = true;
});

ipcMain.on('zmusic:state', (_event, incoming) => {
  if (!incoming || typeof incoming !== 'object') return;
  smokeStats.stateCount++;
  state = {
    status: incoming.status || 'Stopped',
    positionMs: Number(incoming.positionMs) || 0,
    durationMs: Number(incoming.durationMs) || 0,
    volume: typeof incoming.volume === 'number' ? incoming.volume : 1,
    track: incoming.track || {},
  };

  if (mprisHandle) mprisHandle.update(state);
  if (trayHandle) trayHandle.setTooltip(tooltipFor(state));
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
function quitApp() {
  quitting = true;
  app.quit();
}

// 冒烟/诊断模式跳过单实例锁，否则会被已在运行的实例挡住而静默退出。
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二个实例：直接退出，由第一个实例聚焦窗口。
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已有实例在跑时，第二个进程会走到这里：不新开窗口，只把已有窗口带到前台。
    console.log('[main] second-instance: 已有实例在运行，聚焦已有窗口');
    showWindow();
  });

  app.whenReady().then(async () => {
    if (cfg.stripElectronUA) {
      session.defaultSession.setUserAgent(chromeLikeUA());
    }

    Menu.setApplicationMenu(null);
    createWindow();

    mprisHandle = mprisFactory.create({ identity: '网易云音乐', onCommand });
    smokeStats.mpris = mprisHandle ? mprisHandle.busName : null;

    if (cfg.tray) {
      trayHandle = trayFactory.create({
        iconPath: path.join(__dirname, 'assets', 'icon.png'),
        onToggleWindow: toggleWindow,
        onCommand,
        onQuit: quitApp,
      });
      smokeStats.tray = !!trayHandle;
    }

    if (cfg.globalShortcuts) {
      // niri/DMS 已经接管媒体键时不要开，避免双触发。
      for (const key of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) {
        try { globalShortcut.register(key, () => onCommand(keyToAction(key))); } catch (err) {}
      }
    }

    if (SMOKE) runSmoke();
  });

  app.on('window-all-closed', () => {
    if (!cfg.tray) app.quit();
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (trayHandle) trayHandle.destroy();
    try { fs.unwatchFile(config.userCssFile()); } catch (err) {}
  });
}

function keyToAction(key) {
  switch (key) {
    case 'MediaPlayPause': return 'playpause';
    case 'MediaNextTrack': return 'next';
    case 'MediaPreviousTrack': return 'previous';
    case 'MediaStop': return 'stop';
    default: return 'playpause';
  }
}

// ---------------------------------------------------------------------------
// 冒烟测试：不弹窗、跑一段时间后打印诊断并退出
// ---------------------------------------------------------------------------
function runSmoke() {
  const timer = setTimeout(async () => {
    let agentAudio = null;
    try {
      agentAudio = await win.webContents.executeJavaScript(
        '!!(window.__zmusicAgent && window.__zmusicAgent.hasAudio())'
      );
    } catch (err) {
      smokeStats.errors.push('probe: ' + err.message);
    }
    const report = {
      url: (() => { try { return win.webContents.getURL(); } catch { return null; } })(),
      origin: (() => { try { return new URL(win.webContents.getURL()).origin; } catch { return null; } })(),
      agentReady: smokeStats.agentReady,
      agentHasAudio: agentAudio,
      stateCount: smokeStats.stateCount,
      loadCount: smokeStats.loadCount,
      lastState: state,
      mpris: smokeStats.mpris,
      tray: smokeStats.tray,
      errors: smokeStats.errors,
    };
    console.log('SMOKE_REPORT ' + JSON.stringify(report, null, 2));
    quitting = true;
    app.quit();
  }, SMOKE_MS);
  timer.unref?.();
}
