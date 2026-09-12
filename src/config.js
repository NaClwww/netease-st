'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  url: 'https://music.163.com/st/webplayer',
  closeToTray: true,
  startMinimized: false,
  tray: true,
  globalShortcuts: false,
  stripElectronUA: true,
  waylandNative: true,
  waylandDecorations: false,
  disableGpu: false,
  zoom: 1.0,
  userCss: true,
  mediaKeyFallbackSelectors: {
    playPause: [],
    next: [],
    prev: [],
  },
};

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'netease-st');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function userCssFile() {
  return path.join(configDir(), 'user.css');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function load() {
  const dir = configDir();
  const file = configFile();
  let user = {};
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    } else {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn('[config] 读取失败，使用默认值:', err.message);
  }
  return deepMerge(DEFAULTS, user);
}

/** 从 cfg.url 拆出 host 与 pathname，供注入拦截精确命中。 */
function parseTarget(url) {
  try {
    const u = new URL(url);
    return { protocol: u.protocol, host: u.hostname, path: u.pathname };
  } catch {
    return { protocol: 'https:', host: 'music.163.com', path: '/st/webplayer' };
  }
}

module.exports = { load, configDir, configFile, userCssFile, parseTarget, DEFAULTS };
