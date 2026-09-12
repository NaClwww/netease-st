#!/usr/bin/env electron
// L1 注入层原型 —— 验证「保持 origin + 注入 prelude」这条链路。
//
// 做法：只拦截壳 HTML，把 prelude.js 作为 <head> 里第一个 <script> 注入；
//       其余请求（bundle、API、图片、音频流）全部透传网络。
//       这样 origin 仍是 music.163.com，登录态与 API 都不受影响。
//
// 运行：
//   /usr/lib/electron41/electron src/l1/prototype-main.cjs
//
// 验证点：
//   - window.__zcode 存在，且 prelude 在网易 bundle 之前执行（靠能否截获 Audio 判断）
//   - 播放器用的 <audio> 被截获（它不挂 DOM，普通 querySelector 拿不到）
//   - 能读到 paused / currentTime / duration / volume / rate / mediaSession

const { app, BrowserWindow, session, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

const PRELUDE = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');
const TARGET = 'https://music.163.com/st/webplayer';

function injectPrelude(html) {
  const tag = `<script>${PRELUDE}</scr` + `ipt>`;
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + tag);
  return tag + html;
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;

  await ses.protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'music.163.com' && u.pathname === '/st/webplayer') {
      const res = await net.fetch(req.url, { bypassCustomProtocolHandlers: true });
      const html = await res.text();
      console.log('INJECTED_PRELUDE into shell HTML (' + html.length + ' bytes)');
      return new Response(injectPrelude(html), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return net.fetch(req.url, { bypassCustomProtocolHandlers: true });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280, height: 800,
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadURL(TARGET);
  await new Promise((r) => setTimeout(r, 18000));

  const report = await win.webContents.executeJavaScript(`({
    preludePresent: typeof window.__zcode === 'object' && !!window.__zcode,
    preludeInstalled: !!(window.__zcode && window.__zcode.__installed),
    captureCount: window.__zcode ? window.__zcode.getState().captureCount : -1,
    state: window.__zcode ? window.__zcode.getState() : null,
    origin: location.origin,
    attachedAudio: document.querySelectorAll('audio').length,
    appRendered: document.body.innerText.length,
    sample: document.body.innerText.slice(0, 60)
  })`);

  console.log('REPORT ' + JSON.stringify(report, null, 2));
  app.exit(0);
});
