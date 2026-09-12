// page-agent：注入页面主世界，且在网易 bundle 之前执行。
//
// 职责（对应设计文档 2.4 节）：
//   1. 截获播放器的音频元素。网易用 new Audio() 创建，元素**不挂 DOM**，
//      所以 document.querySelector('audio') 永远拿不到（实测 attachedAudio=0）。
//   2. 汇总播放状态，经 CustomEvent('zmusic:state') 上报给 preload。
//   3. 接收 CustomEvent('zmusic:cmd') 下行命令（seek / volume / rate 等
//      Chromium 媒体键覆盖不到的操作）。
//
// 注意：本文件被拼进一个 script 标签、注入到壳 HTML 的 head 最前面，
//       因此源码（**包括注释**）里绝对不能出现 script 的闭合标签序列，
//       否则会被 HTML 解析器提前截断（踩过这个坑）。

(function () {
  if (window.__zmusicAgent && window.__zmusicAgent.__installed) return;

  var THROTTLE_MS = 500;
  var audio = null;
  var lastPostAt = 0;
  var lastKey = '';

  function readMediaSession() {
    var m = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!m) return null;
    var art = '';
    if (m.artwork && m.artwork.length) art = m.artwork[m.artwork.length - 1].src || '';
    return { title: m.title || '', artist: m.artist || '', album: m.album || '', artUrl: art };
  }

  function snapshot() {
    var a = audio;
    var status = 'Stopped';
    if (a) {
      if (!a.paused) status = 'Playing';
      else if (a.currentTime > 0 && isFinite(a.duration)) status = 'Paused';
    }
    return {
      status: status,
      positionMs: a && isFinite(a.currentTime) ? Math.round(a.currentTime * 1000) : 0,
      durationMs: a && isFinite(a.duration) ? Math.round(a.duration * 1000) : 0,
      volume: a ? a.volume : 1,
      muted: a ? !!a.muted : false,
      rate: a ? a.playbackRate : 1,
      track: readMediaSession() || {},
    };
  }

  function post(force) {
    var s = snapshot();
    var now = Date.now();
    var key = s.status + '|' + s.track.title + '|' + s.track.artist;
    // 状态/曲目变化立即上报；纯进度按 500ms 节流。
    if (!force && now - lastPostAt < THROTTLE_MS && key === lastKey) return;
    lastPostAt = now;
    lastKey = key;
    try {
      window.dispatchEvent(new CustomEvent('zmusic:state', { detail: s }));
    } catch (e) {}
  }

  function wire(el) {
    if (!el || el.__zmusicWired) return;
    el.__zmusicWired = true;
    audio = el;
    var events = ['playing', 'pause', 'ended', 'loadedmetadata', 'durationchange',
      'volumechange', 'ratechange', 'seeked', 'waiting', 'error'];
    for (var i = 0; i < events.length; i++) {
      el.addEventListener(events[i], function () { post(true); });
    }
    post(true);
  }

  // 三条截获路径：构造函数、createElement、以及任何元素的 play()。
  var NativeAudio = window.Audio;
  function PatchedAudio() {
    var el = new NativeAudio(...arguments);
    wire(el);
    return el;
  }
  PatchedAudio.prototype = NativeAudio.prototype;
  try { Object.setPrototypeOf(PatchedAudio, NativeAudio); } catch (e) {}
  window.Audio = PatchedAudio;

  var nativeCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
    var el = nativeCreateElement.apply(document, arguments);
    if (String(tag).toLowerCase() === 'audio') wire(el);
    return el;
  };

  var nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    wire(this);
    return nativePlay.apply(this, arguments);
  };

  // 单一定时器负责进度与 mediaSession 变化的节流上报。
  setInterval(function () {
    if (audio && !audio.paused) post(false);
  }, THROTTLE_MS);

  // 下行命令。
  window.addEventListener('zmusic:cmd', function (ev) {
    var d = ev.detail || {};
    var a = audio;
    if (!a) return;
    try {
      switch (d.action) {
        case 'play': a.play(); break;
        case 'pause': a.pause(); break;
        case 'toggle': a.paused ? a.play() : a.pause(); break;
        case 'seekTo': a.currentTime = Math.max(0, Number(d.value) || 0); break;
        case 'seekBy': a.currentTime = Math.max(0, a.currentTime + (Number(d.value) || 0)); break;
        case 'rate': a.playbackRate = Number(d.value) || 1; break;
        case 'volume': a.volume = Math.min(1, Math.max(0, Number(d.value))); break;
        case 'mute': a.muted = !!d.value; break;
      }
    } catch (e) {}
  });

  window.__zmusicAgent = {
    __installed: true,
    getState: snapshot,
    hasAudio: function () { return !!audio; },
  };

  window.dispatchEvent(new CustomEvent('zmusic:ready', { detail: { agent: 'page-agent', version: 1 } }));
})();
