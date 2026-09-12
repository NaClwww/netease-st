// L1 注入层：在页面主世界、在网易的 bundle 之前执行。
//
// 作用：
//   1. 抓住播放器实例。网易用 `new Audio()` 创建播放元素，它**不挂到 DOM**，
//      所以 document.querySelector('audio') 永远拿不到（实测 attachedAudioCount=0）。
//      这里 hook window.Audio / createElement / HTMLMediaElement.prototype.play 来截获。
//   2. 提供一个稳定的控制/读取接口 window.__zcode，供 preload/主进程经 CustomEvent 调用。
//   3. 预留请求改写钩子（音质降级等 L1 功能）。
//
// 注意：本文件会被拼进一个 script 标签注入到壳 HTML 的 head 最前面，
//       因此代码里绝对不能出现 script 的闭合标签序列（连注释里也不行，会被 HTML 解析器提前截断）。

(() => {
  if (window.__zcode && window.__zcode.__installed) return;

  const state = {
    __installed: true,
    version: 1,
    audio: null,
    captureCount: 0,
    captures: [],
    hookedOrder: null,
    requestRewrite: null, // 由使用方注册：fn(url, body) => {url, body} | null
  };

  function hook(el) {
    if (!el || el.__zcodeHooked) return;
    el.__zcodeHooked = true;
    state.audio = el;
    state.captureCount++;
    state.captures.push({ at: Date.now(), src: String(el.currentSrc || el.src || '').slice(0, 120) });
    const emit = (type) => () => {
      try {
        window.dispatchEvent(new CustomEvent('zmusic:state', { detail: state.api.getState() }));
      } catch (e) {}
    };
    for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'volumechange', 'ratechange', 'seeked', 'error']) {
      el.addEventListener(ev, emit(ev));
    }
  }

  const origAudio = window.Audio;
  function PatchedAudio(...args) {
    const el = new origAudio(...args);
    hook(el);
    return el;
  }
  PatchedAudio.prototype = origAudio.prototype;
  Object.setPrototypeOf(PatchedAudio, origAudio);
  window.Audio = PatchedAudio;

  const origCreate = document.createElement.bind(document);
  document.createElement = function (tag, ...rest) {
    const el = origCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'audio') hook(el);
    return el;
  };

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    hook(this);
    return origPlay.apply(this, a);
  };

  const api = {
    hasAudio: () => !!state.audio,
    getState() {
      const a = state.audio;
      return {
        captureCount: state.captureCount,
        hasAudio: !!a,
        paused: a ? a.paused : null,
        currentTime: a ? a.currentTime : null,
        duration: a ? (isFinite(a.duration) ? a.duration : null) : null,
        volume: a ? a.volume : null,
        muted: a ? a.muted : null,
        rate: a ? a.playbackRate : null,
        src: a ? String(a.currentSrc || a.src || '').slice(0, 120) : null,
        mediaSession: navigator.mediaSession && navigator.mediaSession.metadata
          ? { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist, album: navigator.mediaSession.metadata.album }
          : null,
      };
    },
    cmd(name, arg) {
      const a = state.audio;
      if (!a) return false;
      try {
        switch (name) {
          case 'play': a.play(); return true;
          case 'pause': a.pause(); return true;
          case 'toggle': a.paused ? a.play() : a.pause(); return true;
          case 'seek': a.currentTime = Number(arg); return true;
          case 'rate': a.playbackRate = Number(arg); return true;
          case 'volume': a.volume = Math.max(0, Math.min(1, Number(arg))); return true;
          case 'mute': a.muted = !!arg; return true;
          default: return false;
        }
      } catch (e) { return false; }
    },
    setRequestRewrite(fn) { state.requestRewrite = typeof fn === 'function' ? fn : null; },
  };
  state.api = api;
  window.__zcode = api;
  window.__zcode.__installed = true;
  window.__zcode.state = state;

  window.dispatchEvent(new CustomEvent('zmusic:ready', { detail: { version: 1 } }));
})();
