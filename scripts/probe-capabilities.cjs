#!/usr/bin/env electron
// 能力探测：EME keySystem 支持情况 + 音频编解码器支持矩阵。
//
// 用法（用系统 Electron 跑，无需 npm install）：
//   /usr/lib/electron41/electron scripts/probe-capabilities.cjs
//
// 要点：
//   - EME 只在安全上下文可用，所以起一个本地 http://127.0.0.1 服务（被视为 secure）。
//     用 data: URL 探测会得到假阴性（API 直接消失）。
//   - 「API 不存在」抛 TypeError；「CDM 不支持」抛 NotSupportedError，两者要区分。
//   - 用 CJS + 文件入口：无 package.json 时 Electron 不认 .mjs 独立入口（会静默挂住）。

const { app, BrowserWindow } = require('electron');
const http = require('node:http');

const KEY_SYSTEMS = [
  'com.widevine.alpha',
  'org.w3.clearkey',
  'com.microsoft.playready',
];

const CODECS = {
  mp3: 'audio/mpeg',
  m4a_aac: 'audio/mp4; codecs="mp4a.40.2"',
  flac: 'audio/flac',
  flac_in_mp4: 'audio/mp4; codecs="flac"',
  ec3_dolby: 'audio/mp4; codecs="ec-3"',
  ac3: 'audio/mp4; codecs="ac-3"',
  alac: 'audio/mp4; codecs="alac"',
  opus: 'audio/webm; codecs="opus"',
};

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>probe</title><body>probe</body>');
});

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL(`http://127.0.0.1:${port}/`);

  const probe = `(async () => {
    const out = {
      isSecureContext: window.isSecureContext,
      emeApiPresent: typeof navigator.requestMediaKeySystemAccess === 'function',
      keySystems: {},
      codecs: {},
    };

    if (out.emeApiPresent) {
      for (const ks of ${JSON.stringify(KEY_SYSTEMS)}) {
        try {
          const access = await navigator.requestMediaKeySystemAccess(ks, [{
            initDataTypes: ['cenc'],
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          }]);
          out.keySystems[ks] = 'SUPPORTED (' + access.keySystem + ')';
        } catch (e) {
          out.keySystems[ks] = e.name + ': ' + e.message;
        }
      }
    }

    const a = document.createElement('audio');
    for (const [name, mime] of Object.entries(${JSON.stringify(CODECS)})) {
      out.codecs[name] = a.canPlayType(mime) || 'NO';
    }
    return out;
  })()`;

  const result = await win.webContents.executeJavaScript(probe);
  console.log(JSON.stringify({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    ...result,
  }, null, 2));

  server.close();
  app.exit(0);
});
