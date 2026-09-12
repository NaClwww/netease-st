'use strict';

// MPRIS 服务（org.mpris.MediaPlayer2.netease_st）。
//
// 用 mpris-service（基于 dbus-next，纯 JS，无需原生编译）。已在本机实测：
// 总线名可被 busctl/gdbus 看到，接口齐全。
//
// 已知坑：mpris-service 不会自动维护播放位置，Position 属性要自己按上报状态推进。

const BUS_NAME = 'netease_st';

function trackPath(track) {
  const key = `${track.title || ''}\u0000${track.artist || ''}\u0000${track.album || ''}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return '/org/mpris/MediaPlayer2/Track/' + h.toString(16);
}

function splitArtists(artist) {
  if (!artist) return undefined;
  return String(artist).split(/[/、,;&]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {object} opts
 * @param {string} opts.identity  显示名
 * @param {(action: string, value?: number) => void} opts.onCommand 命令回调
 */
function create({ identity, onCommand }) {
  let mpris;
  try {
    mpris = require('mpris-service');
  } catch (err) {
    console.warn('[mpris] mpris-service 不可用，MPRIS 已禁用:', err.message);
    return null;
  }

  let player;
  try {
    player = mpris({
      name: BUS_NAME,
      identity,
      supportedUriSchemes: [],
      supportedMimeTypes: [],
      canQuit: true,
      canRaise: true,
      canSetFullscreen: false,
      hasTrackList: false,
    });
  } catch (err) {
    console.warn('[mpris] 注册失败:', err.message);
    return null;
  }

  let positionUs = 0;
  player.getPosition = () => positionUs;

  player.on('play', () => onCommand('play'));
  player.on('pause', () => onCommand('pause'));
  player.on('playpause', () => onCommand('playpause'));
  player.on('next', () => onCommand('next'));
  player.on('previous', () => onCommand('previous'));
  player.on('stop', () => onCommand('stop'));
  player.on('quit', () => onCommand('quit'));
  player.on('raise', () => onCommand('raise'));
  player.on('seek', (offsetUs) => onCommand('seekBy', Number(offsetUs) / 1e6));
  player.on('position', (e) => onCommand('seekTo', Number(e && e.position) / 1e6));
  player.on('volume', (v) => onCommand('volume', Number(v)));

  return {
    player,
    busName: 'org.mpris.MediaPlayer2.' + BUS_NAME,
    update(state) {
      const status = state.status === 'Playing' ? 'Playing'
        : state.status === 'Paused' ? 'Paused' : 'Stopped';
      player.playbackStatus = status;
      positionUs = Math.max(0, Math.round((state.positionMs || 0) * 1000));

      const t = state.track || {};
      const meta = { 'mpris:trackid': trackPath(t) };
      if (state.durationMs) meta['mpris:length'] = Math.round(state.durationMs * 1000);
      if (t.title) meta['xesam:title'] = t.title;
      const artists = splitArtists(t.artist);
      if (artists) meta['xesam:artist'] = artists;
      if (t.album) meta['xesam:album'] = t.album;
      if (t.artUrl) meta['mpris:artUrl'] = t.artUrl;
      player.metadata = meta;

      if (typeof state.volume === 'number') {
        try { player.volume = state.volume; } catch (err) {}
      }
    },
  };
}

module.exports = { create, BUS_NAME };
