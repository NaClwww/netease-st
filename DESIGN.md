# 网易云音乐网页版 → Linux Electron 桌面壳 · 设计方案

> 目标页面：`https://music.163.com/st/webplayer`
> 目标平台：Arch Linux + niri (Wayland) + DMS
> 文档状态：设计待实施。所有「实测」结论来自 2026-09-11 在本机的抓包 / 静态分析 / Electron 运行时探针。
> 关联文档：本文是旧版设计稿的重写版，新增第 5 节「DRM 专项」。

---

## 0. 结论摘要

1. **默认在线套壳；「沿用他的 JS」只有一种可行姿势（见第 2.6 节）。** origin 必须保持 `https://music.163.com`。用 `session.protocol.handle('https')` 拦截请求、回本地缓存，可以做到 origin 与 cookie 都不变（已实测）；但把 HTML/JS 放本地用 `file://` 或自定义协议加载是死路——代码里有 `location.hostname === "music.163.com"` 分支，host 不符就切到 QA 环境。Linux 桌面集成（托盘、MPRIS、媒体键、关窗进托盘）由 `preload` + 主进程完成，不碰它的业务 JS。
2. **媒体键走 Chromium 原生输入管线（`sendInputEvent`），不靠 DOM 选择器。** 网易的 class 名是构建期哈希，写死必然随改版失效；合成 `KeyboardEvent` 又是 untrusted、没有媒体语义。`sendInputEvent` 直达页面自己注册的 `navigator.mediaSession` handler，我们完全不需要知道它的 DOM。
3. **DRM 不需要做，网页版根本没有 DRM。** 静态分析确认页面代码里不存在 EME：没有 `MediaKeys`、没有 `requestMediaKeySystemAccess`、没有任何 Widevine/PlayReady 引用，播放走的是普通 `new Audio()` + HTTP(S) 音频流。详见第 5 节。
4. **真正会拦住高音质档位的是编解码器，不是 DRM。** 本机 Electron 实测：FLAC / MP3 / AAC 可解，**Dolby 的 EC-3/AC-3 不可解**。所以「杜比全景声 / 沉浸环绕声」这类档位在 Electron 壳里大概率播不了，而无损 / 超清母带（FLAC）可以。这也是第 5 节的重点。
5. **范围边界**：只做「套壳 + 桌面集成 + 界面增强」。登录态、VIP、版权、音质档位完全按网页版给的权限来，不做任何绕过。

---

## 1. 事实基础（实测）

### 1.1 页面与资源

| 项目 | 实测值 |
|---|---|
| HTTP 状态 | `200`，`content-length: 14029`（14KB 静态壳） |
| 服务端 | `volc-dcdn` / `MusicServer`，`x-gw-region: gz` |
| CSP 响应头 | **仅** `upgrade-insecure-requests`（宽松，不阻挡注入） |
| 内联引导变量 | `window._enterAppTime`、`window.withDevServer` |
| 外链域名 | `s5/s6.music.126.net`（静态资源）、`cstaticdun.126.net` + `*.dun.163yun.com`（滑块验证码）、`wr.da.netease.com`（埋点）、`nstool.netease.com` |

首屏引用 5 个资源，全部协议相对 `//` 开头：

```
s5.music.126.net/static_public/<buildId>_<buildId>/
├── vendor/@cloudmusic-desktop/vendors-rudio@0.1.x/vendors-rudio.pc-new.production.js  (~257 KB)
├── hybrid/vendors~app.31d15e2d.js      (2,521,813 B)
├── hybrid/app.4c9df986.js              (5,609,816 B)
├── styles/c226135f0ff638b9e2f0.css     (4,559 B)
└── styles/50d1bb05ebfe221efe2d.css
```

当前 buildId：`68aea63daca57500bb3fb4b6_68aea63daca57500bb3fb4b7`（旧稿记录的值一致，说明这份文档跨天仍成立）。

三个 JS 响应头一致：`access-control-allow-origin: *`、`access-control-allow-credentials: true`、`cache-control: max-age=2592000`。**无鉴权、不校验 referer。**

> 注意：`static_public/<buildId>_<buildId>/` 每次发版都变，任何写死路径的方案都会失效。

### 1.2 播放管线（本次新增，关键）

对 3 个 JS bundle（约 8.4 MB）做关键词与解码后中文串扫描，结论：

| 探测项 | 结果 |
|---|---|
| `MediaKeys` / `onencrypted` / `requestMediaKeySystemAccess` | **0 次** |
| `com.widevine.alpha` / `widevine` / `playready` / `clearkey` | **0 次** |
| EME 能力探测函数（`isDrmSupported` / `supportDrm` / `EMESupport` …） | **0 次** |
| `MediaSource` / `SourceBuffer`（MSE） | **0 次** |
| `new Audio(` | 8 次 |
| `crossOrigin` | 19 次 |
| `canPlayType` | 24 次 |
| `navigator.mediaSession` | 5 次 |

**判定：播放是纯 `<audio>`（`new Audio()`）直连 HTTP 音频流，配 `mediaSession` 元数据，既无 MSE 也无 EME。** 之前 grep 到的 `encrypted` 命中全部来自 React 的 DOM 事件名列表（`"abort canplay ... encrypted ended error ..."`），`drm` / `keyId` 命中是 base64 与 `_nk:"duDRm1"` 之类的噪音。

这对本项目是好消息，带来两点确定性：
- `navigator.mediaSession` 确实存在 → MPRIS 元数据与 `sendInputEvent` 媒体键都有了可靠的落点，第 2.2 / 2.3 节的方案成立。
- 没有 EME → 不需要 Widevine，套壳路线没有 DRM 门槛。

音质档位的请求参数也确认了：接口 `/api/song/enhance/player/url/v1`，请求体含 `level`、`encodeType`、`immerseType`、`trialMode`、`audioScene`、`audioPlay`。

另外发现一个非 DRM 的集成点：埋点里带 `p2pType:"迅雷"`、`isP2P`，说明网页版可能对部分资源启用 P2P 加速。默认不干预；若发现异常流量或与去广告类扩展冲突再单独处理。

### 1.3 音质档位 × 编解码器矩阵

从 bundle 里解出的档位表（`bitRate` 为服务端标记值）：

| 档位 | serverUsedId | bitRate | 会员要求 |
|---|---|---|---|
| 沉浸环绕声 | `sky` | 5999 | SVIP |
| 超清母带 | `jymaster` | 4999 | SVIP |
| 高清臻音 | `jyeffect` | 3999 | VIP |
| 杜比全景声 | `dolby` | 2999 | SVIP |
| 高解析度无损 | `hires` | 1999 | VIP |
| 无损 | `lossless` | 999 | VIP |
| 极高 | `exhigh` | 320 | — |
| 较高 | `higher` | 192 | — |
| 标准 | `standard` | 128 | — |
| 64aac | `64acc` | 64 | — |

本机 Electron 41 的 `canPlayType` 实测：

| MIME | 结果 |
|---|---|
| `audio/mpeg` (MP3) | `probably` ✅ |
| `audio/mp4; codecs="mp4a.40.2"` (AAC) | `probably` ✅ |
| `audio/flac` / `audio/mp4; codecs="flac"` | `probably` ✅ |
| `audio/webm; codecs="opus"` | `probably` ✅ |
| `audio/mp4; codecs="ec-3"`（Dolby Digital Plus） | **NO** ❌ |
| `audio/mp4; codecs="ac-3"` | **NO** ❌ |
| `audio/mp4; codecs="alac"` | **NO** ❌ |

推断（未逐档实测，实施时用真实曲目验证）：**无损 / 超清母带（FLAC）可播**；**杜比全景声 / 沉浸环绕声若走 EC-3 多声道则播不了**，且这跟账号无关、是解码器缺失。详见 5.5。

### 1.4 本机环境

| 项目 | 状态 |
|---|---|
| Node / npm | `v26.8.2` / `12.0.2`，registry 通 |
| Electron | 系统装 `electron41` (41.10.7)、`electron42` (42.9.3)；`/usr/lib/electron41/electron` |
| Electron 二进制 | 不在 PATH；`extra/electron` 可装（体积大，建议复用系统版） |
| 会话 | Wayland，`WAYLAND_DISPLAY=wayland-1`，`DISPLAY=:0`，`XDG_CURRENT_DESKTOP=niri` |
| 图像工具 | `magick`、`convert`、`rsvg-convert`、`python3` + PIL ✅ |
| 缺的工具 | `xvfb-run` ❌（冒烟测试会真弹窗）、`icotool` ❌、`playerctl` ❌（测 MPRIS 要装） |
| D-Bus | `busctl`、`dbus-send` ✅ |
| 系统 Chrome Widevine | `/opt/google/chrome/WidevineCdm`，版本 `4.10.3112.0`，Linux 下 `persistent-license-support: false` |

### 1.5 官方桌面客户端（Windows / macOS）逆向结论

**结论：桌面客户端与 `/st/webplayer` 是同一套 "hybrid" 应用的不同构建，但客户端不联网加载这个页面** —— 它自带一份同源 UI 包，用内部 `orpheus://` 协议加载，HTTP 经原生层转发。所以「网页版缺的那些功能」不是被阉割，而是由客户端自己的原生宿主实现。Windows 与 macOS 结论一致。

实测对象（2026-09-11）：

| 平台 | 安装包 | 大小 | UI 包 | 版本标识 |
|---|---|---|---|---|
| Windows x64 | `NeteaseCloudMusic_Music_official_3.1.40.205461_64.exe`（`/download/pc/latest`，NSIS） | 166 MB | `package/orpheus.ntpk` | `VERSION=patch-pc-1`，`COMMITHASH=5b23b4d` |
| macOS 通用 | `NeteaseCloudMusic_Music_official_3.1.8.3330.dmg`（`/api/osx/download/latest`） | 302 MB | `Contents/Resources/resources.pack` | `VERSION=patch-pc-1`，`COMMITHASH=f23ceff` |
| macOS arm64 | `…_3.1.8.3330_arm64.dmg`（同目录，**下载页不露出**，需自己拼文件名） | 170 MB | 同左（与通用包字节级相同） | 同左 |

> mac 的「通用」dmg 里主程序是 x86_64 + arm64 双架构，`_arm64.dmg` 是纯 arm64（主程序 14.3 MB vs 通用 30.1 MB）。两个 dmg 的 `resources.pack` MD5 完全相同（`79d12f87933a40690feef931fb878262`），即 UI 与 CPU 架构无关，只有二进制分架构。本机是 Linux，dmg 用 `7z x` 直接解。

| 项 | web 版 | Windows 客户端 | macOS 客户端 |
|---|---|---|---|
| 运行时 | Electron（本项目 41/42，Chromium 146） | **CEF 91**（`libcef.dll` 155 MB，`chromium-91.0.4472.169`）+ 原生宿主 `cloudmusic.dll`（37 MB）；**不是 Electron** | **CEF + WKWebView 双引擎**：主程序同时链接 `Chromium Embedded Framework.framework` 与 `WKWebView`（`WKUserContentController`、`MAMWKWebViewNavigationDelegateProxy`、`YYYWebKitCallbackManager`） |
| UI 资源 | `s5.music.126.net/…/hybrid/app.4c9df986.js` | `package/orpheus.ntpk`（zip，37 MB）内 `pub/hybrid/app.chunk.5b23b4d.js` | `Contents/Resources/resources.pack`（zip，37 MB）内 `webfiles/hybrid/app.chunk.f23ceff.js` |
| 资源根 | 构建期 `isWeb=true`：`n.isWeb?"/st/webplayer/public/":"public/"` | 同表达式折叠成常量 `"orpheus://orpheus/pub/public/"`（`isWeb=false`） | 同为折叠常量 `"orpheus://orpheus/pub/public/"` |
| 入口 | `/st/webplayer` 的服务端 HTML | `orpheus://orpheus/pub/app.html` | 同左（`app.html` 的 CSP 逐字相同） |
| 宿主桥 | 无（`window.channel` 不存在，走 websdk 降级） | CEF 注入 `window.channel`，`Bridge` 转发 `os.* / player.* / download.* / update.*` | 同左；另有 WKWebView 侧 `window.webkit.messageHandlers.WebViewBridge` |
| HTTP | 页面直连 `music.163.com/api/*` | 经 `orpheus://orpheus/storage/customrequest` 走原生层 | 同左 |

同源证据（按可信度排序）：

1. **第三方资源三方字节级相同**：`vendor/@cloudmusic-desktop/vendors-rudio@0.1.x/vendors-rudio.pc-new.production.js` 在 web、Windows、macOS 三处 MD5 均为 `b34069fbe246ebcfe404b869ee60af8c`。
2. **中文 UI 文案覆盖 95% / 94%**：web 版 1356 条中文串中，Windows 包命中 1291 条、macOS 包命中 1278 条（客户端反而更多，因为还含 `_next` 子应用）。注意 web 构建把非 ASCII 转义成 `\uXXXX`、客户端构建保留 UTF-8，必须先解码再比（见附录 12）。
3. API 端点交集 382 条，jaccard ≈ 0.76–0.86。
4. 两边都调用同名宿主接口：`Bridge.call("os.getSystemInfo")`、`os.navigateExternal`、`player.getId`、`player.renderLRCImage`。
5. 目录/模块命名一致：`hybrid/app`、`hybrid/subApp`、`hybrid/vendors~app`、`styles/`；`asset-manifest.json` 都映射到 `/pub/…`。

附带发现：

- 客户端 `libcef.dll` 带 Widevine CDM loader（`cef_register_widevine_cdm`、`com.widevine.alpha`、`InstallWidevineCdm`），说明**宿主具备 EME 能力**；但应用层 bundle 仍无 EME 调用，与第 5 节结论一致。
- **macOS 会注入两个 hook 脚本**：`MKWebFastHookAjax.js`（暴露 `WFJSBridge`，hook `fetch` / `XMLHttpRequest`）与 `YYYWebCookieHookAjax.js`（覆写 `document.cookie` 的 setter，把写入经 `window.webkit.messageHandlers.WebViewBridge` 上报 `browser.setCookie`）。**官方壳也是在同一层做拦截**，而且选的是 WKWebView 原生 bridge、不是改网络 —— 与本项目 L1 思路一致，可作为可行性旁证。
- 其余组件：Windows 侧有 `native.ntpk`（加密 zip，仅 `start.html` + `version.dat`）、`common.skin` / `dark.skin`、FFmpeg 全家桶、`nim*.dll`（IM）、`nertc_sdk.dll`（RTC）、`cronet.72.0.3626.122.dll`；macOS 侧有 `Sparkle.framework`（自更新）、`AudioCodec.framework`、`FLAC.framework`、原生迷你播放器素材（`Contents/Resources/MiniPlayer*.tiff`）。
- 客户端 UA：`… Chrome/120.0.0.0 Safari/537.36 NeteaseMusicDesktop/<ver>`；web 侧 bundle 里也有一条 `NeteaseMusicDesktop\/([\d\.]+)?` 正则用于识别客户端。
- win/mac 的 `_next/static/chunks/235-9be43072f568e756.js` MD5 相同（`33a4694ae88aed1f1326c71d7f985f94`）。

**对本项目的意义**：桌面歌词 / 迷你播放器 / 本地音乐 / 下载由原生宿主提供（mac 上迷你播放器甚至是原生 AppKit 实现），要在 Electron 里补，等价于重写客户端暴露给页面的 `window.channel` 接口面（2.8 已列）。客户端那份构建不对公网提供，`orpheus://` 还需要自定义协议 + 原生桥，所以**没有捷径可抄**；2.6 的在线套壳路线依然成立。

---

## 2. 架构

### 2.1 进程模型

```
┌──────────────────────── 主进程 (src/main.js) ────────────────────────┐
│ 窗口生命周期 / 单实例 / 托盘 / 配置 / 断网兜底页 / 编解码器能力探测     │
│                                                                      │
│  ┌── MPRIS 服务 (src/mpris.js) ─────────────┐                        │
│  │ org.mpris.MediaPlayer2.netmusicdesktop   │ ← niri / DMS / playerctl│
│  └──────────────────────────────────────────┘                        │
│                    ▲ 状态上报 (IPC)   │ 命令下发 (IPC)                │
│  ┌── preload.js（隔离世界，contextIsolation: true）────────────────┐  │
│  │ DOM CustomEvent 双向桥：zmusic:state ↑ / zmusic:cmd ↓          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                    ▲ CustomEvent      │ CustomEvent                  │
│  ┌── page-agent.js（注入页面世界，<script> 注入）──────────────────┐  │
│  │ 采集：<audio> + navigator.mediaSession.metadata                │  │
│  │ 执行：DOM 兜底点击（选择器可配置）                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                    │                                                  │
│  ┌── Chromium 输入管线：sendInputEvent(MediaPlayPause / Next / Prev)┐│
│  │ → 直达页面的 MediaSession handler（不依赖任何选择器）           ││
│  └────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
                              │
                     https://music.163.com/st/webplayer （线上，origin 不变）
```

### 2.2 决策一：媒体键走 `sendInputEvent`

**问题**：切歌要点「下一首」按钮，但网易 class 名是构建期哈希，写死必然失效；用 `executeJavaScript` 合成 `KeyboardEvent` 也不触发媒体语义（untrusted event）。

**方案**：主进程发原生输入事件，

```js
win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'MediaPlayPause' })
win.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'MediaPlayPause' })
```

`MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop` 都是 Electron Accelerator 合法 keyCode，走 Chromium 原生输入管线派发给页面注册的 `navigator.mediaSession` handler。**已确认页面确实使用 `mediaSession`（1.2 节），所以这条主路径有落点。**

**降级链**（按序尝试）：

1. `sendInputEvent` 媒体键（主路径）
2. 配置项 `mediaKeyFallbackSelectors.next/prev` 的 CSS 选择器点击（用户在 DevTools 自找自填）
3. `<audio>` 元素直控（仅 play / pause / seek 可行）

### 2.3 决策二：MPRIS 是 niri 环境下的正确集成点

- **`globalShortcut` 默认关闭**：niri/DMS 已经接管媒体键，Electron 再抢会冲突或双触发。
- 用 `mpris-service`（基于 `dbus-next`，**纯 JS，无原生编译**）注册：
  - 总线名 `org.mpris.MediaPlayer2.netmusicdesktop`
  - 接口 `org.mpris.MediaPlayer2` + `...Player`
  - `Metadata`：`mpris:trackid` / `mpris:length` / `xesam:title` / `xesam:artist` / `xesam:album` / `mpris:artUrl`
  - `PlaybackStatus`：`Playing` / `Paused` / `Stopped`
  - 方法 `Play` / `Pause` / `PlayPause` / `Next` / `Previous` / `Stop` / `Seek` / `SetPosition` 全部转发到 2.2 的媒体键通道
- **已知坑**：`mpris-service` 不自动维护播放位置，`Position` 要自己按上报状态推进（或只发 `Seeked`）。`Position` 是规范要求属性，别漏。
- **待实测**：Chromium 在 Linux 自带一套 MPRIS，可能与我们的重复注册，导致 `playerctl -l` 出现两个播放器。先 `busctl --user list | grep -i mpris` 确认；真重复再考虑屏蔽 Chromium 那套。

### 2.4 决策三：页面状态怎么采

`contextIsolation: true` 下 preload 与页面是两个 JS 世界，但**共享同一个 DOM**，用 `window` 上的 `CustomEvent` 互通即可。

注入页面世界的 `page-agent.js` 负责：

- **元数据**：优先 `navigator.mediaSession.metadata`（`title` / `artist` / `album` / `artwork[0].src`）
- **播放状态**：优先 `<audio>` 的 `paused` / `currentTime` / `duration` / `volume`
- **变化通知**：`audio` 的 `play` / `pause` / `timeupdate` / `loadedmetadata` + `MutationObserver`（切歌时媒体会话元数据会变）
- **节流**：位置类信息 500ms 汇总一次，避免 IPC 洪水

上报格式（`window.dispatchEvent(new CustomEvent('zmusic:state', { detail }))`）：

```js
{
  status: 'Playing' | 'Paused' | 'Stopped',
  track: { title, artist, album, artUrl, id },
  positionMs, durationMs, volume
}
```

### 2.5 其余工程决策

| 决策 | 做法 | 理由 |
|---|---|---|
| 窗口 | 1280×820，min 900×600，`autoHideMenuBar` | 网页版布局所需 |
| 后台节流 | `backgroundThrottling: false` | 隐藏/最小化到托盘后进度与元数据仍要上报 MPRIS |
| 单实例 | `app.requestSingleInstanceLock()`，第二实例只聚焦已有窗口 | 避免多份 cookie 会话打架 |
| 关窗行为 | `close` 里 `preventDefault()` + `hide()`；托盘「退出」才真退 | 关窗继续放歌是常规预期 |
| 外链 | `setWindowOpenHandler` + `will-navigate`：`*.music.163.com` 内部放行，其余 `shell.openExternal` | 登录页可能弹窗 |
| 登录持久化 | Electron 默认 userData 下 cookie 存储 | 重启免登 |
| UA | **剥离 `Electron/xx.x.x` token**，伪装普通 Chrome | 避免站点按 UA 拒绝 Electron；默认开，可关 |
| Wayland | 默认 `--ozone-platform-hint=auto`；`--enable-features=WaylandWindowDecorations` 可选 | niri 下原生 Wayland 更稳 |
| WM Class | `app.commandLine.appendSwitch('class', 'netmusicdesktop')` | 对齐 `.desktop` 的 `StartupWMClass`，图标才正确 |
| 硬件加速 | 默认开；提供 `--disable-gpu` 开关 | Wayland 渲染异常的逃生门 |
| 断网兜底 | `did-fail-load` → 本地 `offline.html`（带重试） | 比白屏好 |
| 图标 | 站点 favicon 抓取后 `magick` 转 512×512 PNG | 工具链已具备 |
| 编解码器探测 | 启动时 `audio.canPlayType` 探测并把结果写日志 | 5.5 节的高音质限制要可诊断 |

### 2.6 架构选项：在线套壳 vs 本地化他们的 JS

先给结论：**「沿用他提供的 JS」只有一种正确姿势——保持 origin 为 `https://music.163.com` 的运行时拦截缓存。把 HTML/JS 放本地用 `file://` 或自定义协议加载是死路。** 而且即便姿势正确，它也只是**缓存加速层**，不能替代在线加载，更不能离线播放。

三个选项对比：

| | A 纯在线（默认推荐） | B 运行时拦截 + 本地缓存 | C 自定义协议 / `file://` 全本地 |
|---|---|---|---|
| 加载方式 | 全部走 CDN | 壳与 chunk 走本地缓存，API / 音频流 / 风控 SDK 透传 | 全部本地 |
| origin | `music.163.com` | **`music.163.com`（已验证保持）** | `app://local` 或 `null` |
| cookie / 登录 | ✅ | ✅（已验证 cookie 可见且随请求携带） | ❌ 不携带 |
| 离线播放 | ❌ | ❌（API 与音频流仍需网络） | ❌ |
| 抗改版 | ✅ 自动跟随 | ⚠️ 需按 buildId 重新同步 | ❌ 冻结在旧版本 |
| 维护成本 | 低 | 中 | 高且脆弱 |
| 法律 | 干净 | 个人机器缓存，接近浏览器缓存 | **随应用分发即侵权** |

**已验证：HTTPS 拦截能同时保住 origin 与 cookie。** 实测（Electron 41，`session.protocol.handle('https', handler)`）把 `/st/webplayer` 的响应换成本地内存里的 HTML 后：`location.origin` 仍是 `https://music.163.com`，`isSecureContext: true`，且预置的 `.music.163.com` cookie（`MUSIC_U`）在页面里 `document.cookie` 可见。**所以「改本地加载 → 登录必挂」只对 `file://` / 自定义协议成立，对 HTTPS 拦截不成立。**

**为什么全本地（C）必然失败（实测证据）：**

1. **代码里有 hostname 分支**：
   ```js
   if (!b.inPuppeteerOrTester) {
     var _ = "music.163.com" === window.location.hostname;
     f.a.init({ apiDomain: _ ? "interface.music.163.com" : "qa.igame.163.com" });
   }
   ```
   hostname 一旦不是 `music.163.com`，应用会切到 **QA 测试环境域名**，登录与接口全错。
2. **存储按 host 分命名空间**：`NM_AUTO_COOKIE_http://music.163.com_ENCRYPT`、`NM_ANONIMOUS_DATA_http://music.163.com_ENCRYPT`、`anonimousHost.storeBy.domain` 等键都绑死 `http://music.163.com`，换 host 等于换了一套空存储 → 未登录。
3. **buildId 烘进 JS**：`app.js` 里有 **107 处** `//s5.music.126.net/static_public/<buildId>/...` 绝对资源地址，自带 buildId。缓存下来的旧 bundle 会去请求旧 buildId 的资源。

**为什么 B 也只是加速层，不是替代品：**

1. **首屏就要 41 个 JS**（实测请求日志）：3 个主包 + 约 35 个 `hybrid/<id>.<hash>.js` 懒加载 chunk，chunk id 已见 0–170+。完整镜像要覆盖 170+ 个带内容哈希的文件，且随改版全部变化。
2. **第三方风控 SDK 无法镜像**：`s6.music.126.net/puzzle/puzzle@005EEC.js`（滑块验证码）、`acstatic-dun.126.net/.../watchman.min.js`、`st.qa.igame.163.com/cmf-validator-sdk` 与 `cmf-injector-sdk`、`music-corona.min.js`、`musicapm.min.js`。这些是登录风控依赖，必须透传网络。
3. **API 与音频流永远要网络**：离线播放做不到（真要离线就得下载歌曲，那是版权 / DRM 禁区）。
4. **运行期 `import()` 动态 SDK**：如 `NeAvEditorWeb.js` / `NeAvEditorTimeline.js`（歌词特效编辑器），按需从网络加载。

**另一个必须知道的发现**：代码里有 `inPuppeteerOrTester` 分支，说明站点有**反自动化检测**。用 DevTools 协议 / Puppeteer 反复驱动可能被识别——这也是本方案坚持「`sendInputEvent` 原生输入管线 + 不做异常请求」的原因之一。Electron 默认不带 `navigator.webdriver`，正常使用无影响。

**建议**：默认走 A。只有当 CDN 冷启动慢到无法忍受时，再按 B 加一层**按 buildId 分目录的只读缓存**——只缓存 `s5/s6.music.126.net` 白名单内的静态资源，API / 风控 / 音频流一律透传，并做「命中缓存 vs 直连 CDN」的登录与播放行为对比。C 直接放弃。

### 2.7 「魔改」他们的 JS：可行，但要按 buildId 管理

> **状态**：方案与实测结论已记录，**暂缓实施**。原型与数据见本节。

**已验证可行。** 实测做法：把 3 个主包拉到本地，在 `app.js` 末尾注入一个标记，再用 `protocol.handle('https')` 在请求时把改过的字节连同本地壳 HTML 一起返回。结果：

- `location.origin` = `https://music.163.com`，`isSecureContext` = true；
- 注入的 `window.__PATCHED_APP__ === true`，确认跑的是改过的字节；
- 应用正常启动并渲染（body 里出现「精选 / 播客 / 关注 / 我喜欢的音乐 / 未登录 / 歌单广场 / 排行榜 / 歌手 / VIP」）；
- 联网照常：单次启动 66 个网络请求，其中 `interface.music.163.com` 3 个真实 API 调用返回 200（**注意 API 域名是 `interface.music.163.com`**，来自 2.6 节的 hostname 分支），懒加载 chunk 从 `s5/s6.music.126.net` 正常拉取，风控 SDK（dun/watchman、igame validator/injector）照常加载。

所以「下载 → 魔改 → 加载 → 照常联网」这条链路是通的，技术门槛不高，难点全在**维护**。

**推荐两层改法：**

| 层 | 做法 | 稳定性 |
|---|---|---|
| L1 运行时注入（首选） | 不碰他们的代码，另注入一段 prelude：包 `fetch` / `XMLHttpRequest`、改 `localStorage` 里的功能开关、`insertCSS` 隐藏元素、monkey-patch 全局 | 高，多数改版不失效 |
| L2 静态改写（更强但脆） | 在 `protocol.handle` 里对 `app.js` 做正则改写（去广告、改默认音质、改文案、禁埋点） | 低，每次发版都要重做 |

**铁律：**

1. **不要锚定 minified 变量名**（每次发版都变）。要锚定稳定串：API 路径、URL、`\uXXXX` 转义的文案、明确的常量。
2. **buildId 烘在 bundle 里**（`app.js` 有 107 处绝对资源地址）。改过的包是**冻结版本**：它请求的是旧 buildId 的资源，站点一发新版、旧资源被清就会 404。所以必须**按 buildId 整包缓存 + 原子替换 + 每次发版重新打补丁**；新 build 校验失败就回退到未打补丁的 CDN 版本，绝不硬失败。
3. **懒加载 chunk（170+）不会跟着改**，新旧混用会出微妙错乱。要冻结就整包冻结，要跟随就整包重新拉。
4. **别过度改请求 / 埋点**：站点有 `inPuppeteerOrTester` 检测与 dun/watchman 风控，改网络行为过头可能触发风控。
5. **能做与不能做**：改功能开关、UI、文案、默认音质 = 可以；绕过 VIP / 版权 / 服务端鉴权 = 不可以（那是服务端说了算）；离线播放 = 做不到。
6. 若真要做 L2 静态改写，**别用 `protocol.handle` 全量拦截**（POST 降级、非法头崩主进程，见第 11 节第 11 条）。优先在 CDP 注入层里改写，或只对白名单资源做拦截。

**法律**：自己机器上改着玩，风险最低；**把改过的 bundle 打包分发就是明确的侵权**，别做。

### 2.8 L1 注入层：实测结果与能力边界

> **状态**：注入链路已跑通（`src/l1/`），host bridge 结论已记录，**暂缓实施**；两者的能力边界与抓手保留在本节供后续取用。

**注入链路已验证**（`src/l1/prelude.js` + `src/l1/prototype-main.cjs`，可直接跑）：

- 只拦截壳 HTML，把 prelude 作为 `<head>` 里第一个 `<script>` 注入，其余请求（bundle、API、图片、音频流）全部透传网络 → origin 仍是 `https://music.163.com`，登录 / API 不受影响。
- 实测结果：`preludeInstalled: true`、`captureCount: 2`（说明 prelude 在网易 bundle 之前执行，才可能截获到它们创建的播放元素）、`hasAudio: true`、`paused: true`；而 DOM 里 `attachedAudio: 0`。
- **这证实播放器用 `new Audio()` 创建、不挂 DOM**，`document.querySelector('audio')` 永远拿不到，必须靠原型 hook 截获。旧稿第 3 条风险（「播放是否用 `<audio>` 元素」）到此有了确定答案。
- 踩过的坑：prelude 源码里（**包括注释**）不能出现 script 的闭合标签序列，否则 HTML 解析器会提前截断注入的 script，prelude 会变成页面正文文本。

**重大发现：页面自带一套 host bridge。** bundle 导出（`t.Xxx = ...`）了一整层宿主适配模块：

```
App, AudioEffect, AudioPlayer, Bridge, Browser, Cookie, Cooper360, Database,
Download, EncryptData, Ipc, Library, LocalConfig, Logger, Network, Os, Proxy,
Storage, SubProcess, Thumbnail, Tray, Update, Upload, WindowDesktop ...
```

调用形如 `Bridge.call("os.getSystemInfo")`、`Bridge.call("os.navigateExternal", url)`、`Bridge.call("player.getId")`、`Bridge.call("player.renderLRCImage", ...)`；反向事件用 `Bridge.registerCall("player.onXxx", cb)`；另有 `Tray.subscribeClick/subscribeRightClick/setToolTip`、`WindowDesktop.support/create/destroy`、`AudioPlayer.toggleDesktopLyricStatus/subscribeDeskLyric/setMiniPlayerState/...`。`window.channel[name]` 是其中一条传输路径。

**含义**：网易云网页版本来就是为「跑在原生壳里」设计的（官方 PC 客户端就是那个壳，见 1.5 的逆向结论：同一套 hybrid 代码的两个构建）。**桌面歌词、迷你播放器、托盘、系统音量 / 音效这些功能，页面里已有完整 UI 与逻辑，只是等宿主实现 bridge**；在普通浏览器里它们走 websdk 降级分支而失效。

所以 L1 能做的比预想多得多：

| 能力 | L1 可行性 | 抓手 |
|---|---|---|
| 精确播放状态 / 进度（给 MPRIS） | ✅ 已验证 | hook `Audio` / `HTMLMediaElement.prototype` 截获实例 |
| 播放 / 暂停 / seek / 音量 / 倍速 | ✅ 已验证 | 同上，`__zcode.cmd()` |
| 桌面歌词 | ✅ 高 | 页面已有 `AudioPlayer.toggleDesktopLyricStatus` / `subscribeDeskLyric`，实现 bridge 或自建置顶窗口 |
| 迷你播放器、托盘交互 | ✅ 高 | `Tray.*`、`WindowDesktop.*`、`MiniPlayer*` bridge |
| 音效（杜比 / 沉浸声 / 臻音） | ⚠️ 待实测 | `AudioPlayer.setAudioEffectParams`、`audioEffectSetting`（见 5.5） |
| 均衡器 / 增益 | ⚠️ 中 | Web Audio `createMediaElementSource` 需音频流带 CORS，否则静音 |
| 去广告 / 改文案 / 禁埋点 | ✅ | 请求改写 + CSS / DOM |
| 离线 / 下载 / 绕过 VIP·版权 | ❌ | 服务端授权，不可为 |
| 原生编解码器（若真走 EC-3） | ❌ | JS 层无解，只能降级回退 |

**实现要点：**

1. prelude 必须在页面主世界、且在 bundle 之前执行。做法是 **CDP 的 `Page.addScriptToEvaluateOnNewDocument`**（`webContents.debugger`），不是改 HTML、更不是拦截网络。preload 是隔离世界，改不到页面的原型；`webContents.executeJavaScript` 又太晚。注意：窗口必须先有一个文档（`loadURL('about:blank')`）CDP 命令才有目标，否则 `Page.enable` 永不返回。实测该方式不留 `navigator.webdriver` 指纹（为 false）。
2. 页面的 `Bridge` / `AudioPlayer` 是**模块作用域、不是全局**。要拿它们需走 React-Redux fiber（页面是 React + Redux，`Connect(Component)` 遍布，可触达 `store.getState()` / `dispatch()`），或提供 `window.channel` 让页面自己找上门。
3. 状态回传用 `CustomEvent`（preload 与页面共享 DOM），命令下行同理，preload 做中继（见 2.4）。
4. 页面有 `location.hostname === "music.163.com"` 分支与 host 绑定的存储键，注入时必须保住 origin —— 这正是本方案的做法。

---

## 3. 目录结构

```
netease-st/
├── package.json
├── electron-builder.yml
├── README.md
├── DESIGN.md                 # 本文件
├── src/
│   ├── main.js               # 窗口 / 生命周期 / 单实例 / 外链 / 兜底页
│   ├── config.js             # 配置加载与合并（默认值 + 用户覆盖）
│   ├── preload.js            # 隔离世界事件桥 + IPC
│   ├── page-agent.js         # 注入页面世界：状态采集 + 选择器兜底
│   ├── mpris.js              # MPRIS 服务
│   ├── tray.js               # 托盘（StatusNotifierItem）
│   ├── drm.js                # 可选：Widevine 探测/装载（默认禁用，见第 5 节）
│   ├── l1/
│   │   ├── prelude.js         # 注入页面主世界的 L1 层（已验证）
│   │   └── prototype-main.cjs # 注入链路原型（可直接跑）
│   └── assets/
│       ├── icon.png          # 512×512
│       └── offline.html
├── scripts/
│   ├── dev-system-electron.sh   # 用系统 /usr/lib/electron41/electron 跑
│   ├── probe-capabilities.cjs   # 输出 EME + 编解码器能力矩阵
│   └── fetch-icon.sh
├── arch/                     # Arch 专属打包（其他发行版另开目录，如 deb/）
│   ├── PKGBUILD              # 依赖系统 electron，包体 < 1MB
│   └── netease-st.desktop    # StartupWMClass=netease-st
└── .gitignore                # node_modules / dist / *.AppImage / cache
```

---

## 4. 配置设计

用户配置：`~/.config/netease-st/config.json`（首次启动写默认值）

```json
{
  "url": "https://music.163.com/st/webplayer",
  "closeToTray": true,
  "startMinimized": false,
  "tray": true,
  "globalShortcuts": false,
  "stripElectronUA": true,
  "waylandNative": true,
  "disableGpu": false,
  "zoom": 1.0,
  "userCss": true,
  "drm": {
    "enabled": false,
    "mode": "auto",
    "preferredKeySystems": ["com.widevine.alpha"]
  },
  "mediaKeyFallbackSelectors": {
    "playPause": [],
    "next": [],
    "prev": []
  }
}
```

用户样式：`~/.config/netease-st/user.css`，启动时 `webContents.insertCSS()` 注入，文件 mtime 变化自动重载。**默认留空**——不猜网易的哈希类名。

---

## 5. DRM 专项（核心问题）

### 5.1 结论

**这个套壳项目不需要 Widevine，也不需要任何 DRM 支持。** 网易云音乐网页版的播放链路里根本没有 EME：音频是普通 HTTP(S) 流，直接喂给 `<audio>`。任何「为它接 Widevine」的工作都是过度工程。

真正需要关注的是**编解码器**（5.5 节），以及「万一将来网易给某些档位加 DRM」时的备用方案（5.3 节）。

### 5.2 证据链

**A. 静态分析（1.2 节）** —— 8.4 MB bundle 里 `MediaKeys`、`onencrypted`、`requestMediaKeySystemAccess`、`widevine`、`playready` 全部 0 命中；相反 `new Audio(` / `canPlayType` / `navigator.mediaSession` 大量出现。没有 EME 代码，就不可能触发 Widevine 授权流程。

**B. 运行时探针** —— 用系统 Electron 41 / 42 加载安全上下文后探测：

| keySystem | Electron 41 | Electron 42 |
|---|---|---|
| `com.widevine.alpha` | `NotSupportedError`（无 CDM） | `NotSupportedError` |
| `org.w3.clearkey` | **SUPPORTED** | **SUPPORTED** |
| `com.microsoft.playready` | `NotSupportedError` | `NotSupportedError` |

结论：**stock Electron 的 EME API 存在，但只有 ClearKey，没有 Widevine / PlayReady。** 注意必须在**安全上下文**（HTTPS 或 localhost）下探测——用 `data:` URL 会得到「API 不存在」的假阴性。

**C. 旧开关已失效** —— 试过把系统 Chrome 的 CDM 接进来：

```js
app.commandLine.appendSwitch('widevine-cdm-path',
  '/opt/google/chrome/WidevineCdm/_platform_specific/linux_x64/libwidevinecdm.so')
app.commandLine.appendSwitch('widevine-cdm-version', '4.10.2830.0')
```

实测结果 `NotSupportedError`：**现代 Electron 已不再识别 `--widevine-cdm-path` / `--widevine-cdm-version`**，这套老办法（Electron 1.x–8.x 时代）在本机 41/42 上完全无效。

### 5.3 如果将来真需要 Widevine：castLabs ECS 方案

唯一现实路径是换用 castLabs 的 **ECS（Electron for Content Security）** 预编译版，它打补丁启用了 Widevine 与 Widevine Component Updater。

**已核实的事实**（来自 castlabs/electron-releases，2026-09-11）：可用 tag 形如 `v44.1.0+wvcus`、`v43.5.0+wvcus`、`v42.11.0+wvcus`、**`v41.10.7+wvcus`**、`v41.10.3+wvcus`。其中 `v41.10.7+wvcus` 与我们系统里的 `electron41` 版本号完全一致，迁移成本最低。`+wvcus` 表示走 Widevine Component Updater Service（会自动下载 CDM；旧的 `+wvvmp` 是 VMP 签名路线）。

实施步骤：

```bash
# 1. 安装 ECS 版（不要同时装官方 electron，会冲突）
npm i -D "https://github.com/castlabs/electron-releases#v41.10.7+wvcus"
```

```js
// 2. main.js —— 必须在创建窗口前等 CDM 就绪
const { app, components, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  if (config.drm.enabled) {
    await components.whenReady();          // 首次会触发 CDM 安装，需联网
  }
  createWindow();
});
// 不要加 --disable-component-update，否则 CDM 装不上
```

Linux 限制（必须提前告知用户）：

- castLabs 官方措辞是 Windows/macOS **full support**、Linux **partial support**；
- Linux 下**不支持 persistent license**（系统 Chrome 的 manifest 也写着 `persistent-license-support: false`），只能在线持牌，无法离线播放；
- ECS 预编译版自带的是**开发用 VMP 签名**，只能对接接受开发客户端的 license 服务；某些商用服务要求生产 VMP 签名（castLabs 的 EVS 服务可解决，涉及商务流程）。

**代价评估**：为这个项目引入 ECS = 放弃系统 Electron（包体 +100 MB 或额外下载）、多一个第三方 Electron 分叉的维护依赖、且实际收益为零（因为没 DRM）。**所以默认 `drm.enabled: false`，不引入。** 仅在实测发现某档位/某功能确实走 Widevine 时，才按上面步骤切换。

### 5.4 已排除的方案（避免踩坑）

| 方案 | 结论 |
|---|---|
| stock Electron + `--widevine-cdm-path` 指向系统 Chrome CDM | ❌ 实测无效，开关已被移除 |
| 把 `libwidevinecdm.so` 拷进 Electron 目录 | ❌ Electron 无对应加载逻辑，VMP 签名也不匹配 |
| 用 ClearKey | ❌ 网易不用 ClearKey，而且它只是 EME 的一种，无实际用途 |
| 破解 / 抓密钥 / 逆向 | ❌ 明令不做，见第 9 节 |

### 5.5 真正的门槛是编解码器（不是 DRM）

本机 Electron 41 `canPlayType` 结果（1.3 节）：FLAC / MP3 / AAC / Opus 可解，**EC-3、AC-3、ALAC 不可解**。

映射到网易档位：

| 档位 | 猜测编码 | Electron 能否播 | 备注 |
|---|---|---|---|
| 无损 / 高解析度无损 / 超清母带 | FLAC | ✅ 应该可以 | `audio/flac` 与 `audio/mp4; codecs="flac"` 均 `probably` |
| 杜比全景声 | 疑为「客户端音效」而非 EC-3（见下） | ⚠️ 待实测 | 若是音效则可能可播；若真走 EC-3 则 ❌ |
| 沉浸环绕声 | 疑为「客户端音效」而非 EC-3（见下） | ⚠️ 待实测 | 同上 |
| 高清臻音 | 待确认 | ? | 实施时用真实曲目验证 |
| 极高 / 较高 / 标准 / 64aac | MP3 / AAC | ✅ | 常规档位无风险 |

**注意（重要修正）**：上表最初的「猜测编码」是按业界惯例推断的，但进一步读 bundle 后发现**很可能推错了**。证据是：这些档位在代码里被标为 `envSound` 类型；播放时走的是 `AudioPlayer.setAudioEffectParams(...)` 与 `audioEffectSetting`（`[2999, 3999, 5999].includes(bitrate)` 时才施加音效）；bundle 里没有任何 WASM / AudioWorklet 解码器。**这更像「客户端音效」而不是 EC-3 码流** —— 若如此，杜比 / 沉浸声在 Electron 里可能是能播的。真伪必须用登录 + SVIP 账号实测：看 `audio` 元素实际拿到的响应 `content-type`，以及控制台有无解码错误。

**验证方法**（需要登录 + SVIP 账号）：

```bash
# 在 DevTools 里看 audio 元素当前 src 的响应头 content-type，
# 或直接抓包看 /api/song/enhance/player/url/v1 返回体里的 type/encodeType
```

**如果确认档位走 EC-3**，可选对策（按性价比排序）：

1. **不管它**——让页面自己报错，用户在这些档位上手动切回无损。最简单，推荐。
2. 引导用户在设置里关掉「杜比 / 沉浸声」音效开关（bundle 里有 `audioEffectSetting`，提示语是「{杜比\|沉浸声}已开启，部分歌曲音效不生效」），强制回落到 FLAC/AAC。
3. 编译带 proprietary codecs 的 Electron（`proprietary_codecs=true` + `ffmpeg_branding=Chrome`）——**能解 AAC/MP3 但不含 EC-3 解码**，救不了杜比，不要指望。
4. castLabs ECS 同样**不含 EC-3 解码**，救不了杜比。

> 一句话：**杜比全景声在 Linux Chromium 系里基本无解，接受它。**

### 5.6 DRM 决策建议

- 默认**不做任何 DRM 相关工作**，`drm.js` 只保留一个能力探测函数，把结果打进日志，方便日后排查。
- 在设置页/README 里写明：本应用是浏览器外壳，音质档位受限于 Chromium 的解码能力；杜比全景声不可用是解码器问题，不是登录或会员问题。
- 预留 `drm.enabled` 开关与 5.3 的切换路径，但**不预先引入 ECS 依赖**。

---

## 6. 风险与待实测清单

| # | 风险 | 验证方法 | 退路 |
|---|---|---|---|
| 1 | `sendInputEvent` 媒体键能否被页面 MediaSession 接收 | 播放中调 `sendInputEvent`，看是否暂停 | 配 `mediaKeyFallbackSelectors` 点 DOM |
| 2 | 页面 `navigator.mediaSession.metadata` 是否真的填了标题/歌手 | DevTools 看 `navigator.mediaSession.metadata` | 改从播放条 DOM 抓 |
| 3 | ~~进度信息是否拿得到~~ **已解决** | 播放器用 `new Audio()` 且不挂 DOM；已用 prelude hook 截获（2.8 实测 `captureCount=2`） | —— |
| 4 | Chromium 自带 MPRIS 是否重复注册 | `busctl --user list \| grep -i mpris`，`playerctl -l` | 接受双播放器或查 Electron 开关 |
| 5 | 杜比 / 沉浸声档位的实际编码未知（疑为客户端音效） | 登录后播一首，看响应 `content-type` 与控制台报错 | 若是音效则可播；若真为 EC-3 则引导回落无损（5.5） |
| 6 | 滑块验证码 / 短信登录是否弹独立窗口 | 走一遍登录 | `setWindowOpenHandler` 放行 `dun.163yun.com` |
| 7 | 前端改版导致选择器失效 | —— | 已用媒体键主路径规避 |
| 8 | niri/Wayland 下托盘不显示 | 启动后看托盘区 | 装 `libappindicator-gtk3`；仍不行则 `tray: false` 退化仅 MPRIS |
| 9 | 站点按 UA 拒绝 Electron | 对比改 UA 前后 | `stripElectronUA: true` |
| 10 | 网易对纯壳客户端的账号风控 | 正常使用观察 | 不做异常请求，等价浏览器 |
| 11 | P2P（迅雷）通道在壳内的行为 | 观察网络与 CPU | 页面自带逻辑，默认不干预 |

> 旧稿里的「Widevine/DRM」风险（原 #5）**已从风险清单移除**——第 5 节已证实不存在 DRM 需求。

---

## 7. 打包方案

### 7.1 主方案：electron-builder

- 目标 `AppImage` + `deb`，`category: Audio`，产出 `.desktop`（`StartupWMClass=netmusicdesktop`）
- devDependency 装 `electron` + `electron-builder`
  - **国内注意**：Electron 二进制从 GitHub Releases 拉很慢，加镜像：
    `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm i -D electron electron-builder`
- **可选省流量**：`electronDist: /usr/lib/electron41` + 显式 `electronVersion: 41.10.7`，复用系统 Electron，不下 100 MB。系统目录是「解包后的 dist」，electron-builder 能认，但版本号必须手写；装不出来就退回正常下载。

### 7.2 Arch 原生方案：PKGBUILD + 系统 electron

`arch/PKGBUILD` 要点：

- `depends=('electron' 'libappindicator-gtk3')`
- `build()` 里 `npm install --omit=dev --ignore-scripts`（只装 `mpris-service` 及其依赖）
- 安装到 `/usr/lib/netease-st/`，wrapper：`exec electron /usr/lib/netease-st/src/main.js "$@"`
- 自装 `.desktop` 与图标

好处：包体 < 1 MB。坏处：只适用 Arch。**建议先跑通 electron-builder，再补 PKGBUILD 自用。**

### 7.3 图标

```bash
curl -sSL 'https://music.163.com/favicon.ico' -o /tmp/fav.ico
magick /tmp/fav.ico -resize 512x512 src/assets/icon.png
```

另需 16/32/48/64/128/256/512 的 PNG，`magick` 一条命令批量出。

---

## 8. 实施顺序与验收

### 里程碑

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| M1 | 骨架：`package.json` / `main.js` / 窗口 / 加载线上页 / 持久登录 / 单实例 | 能开窗、能扫码登录、重启免登 |
| M2 | 状态采集 + MPRIS | `playerctl status` 有输出且 metadata 正确 |
| M3 | 媒体键通道 + 托盘 + 关窗进托盘 | 桌面媒体键能暂停/切歌，关窗继续放 |
| M4 | 打包 + 图标 + `.desktop` | AppImage / deb 能装能启动，启动器图标正确 |
| M5 | 能力探测 + 高音质档位实测 + 可选增强 | 第 5.5 节矩阵用真实曲目打勾 |

### 验收清单（逐条实测）

- [ ] `npm start` 出窗口，正确加载网易云网页版
- [ ] 扫码登录成功；**完全退出后重启仍保持登录**
- [ ] 播放歌曲 → `playerctl status` = `Playing`，`playerctl metadata` 标题/歌手正确
- [ ] 按 niri 绑定的媒体键 → 暂停/播放/上一首/下一首生效
- [ ] 点窗口关闭 → 进托盘，音乐**继续播放**
- [ ] 托盘菜单：显示/隐藏、播放暂停、上一首、下一首、退出 全部可用
- [ ] 第二次启动 → 只聚焦已有窗口
- [ ] 断网启动 → 显示兜底页，恢复网络点重试能进
- [ ] 页面内点外部链接 → 系统浏览器打开
- [ ] `npm run dist` → 产出 AppImage + deb，DMS 启动器有条目且图标正确
- [ ] 无损 / 超清母带档位可正常播放（FLAC）
- [ ] 杜比 / 沉浸声档位的实际行为已记录（预期报错，非应用缺陷）

### 排障命令

```bash
# 重新抓页面，看资源清单有没有变（改版时用）
curl -sS -L 'https://music.163.com/st/webplayer' | grep -oE '<script[^>]*src="[^"]+"|<link[^>]*href="[^"]+"'

# MPRIS 是否注册成功
busctl --user list | grep -i mpris
playerctl -l && playerctl status && playerctl metadata

# 用系统 electron 跑
/usr/lib/electron41/electron . --enable-logging

# 能力探测（EME + 编解码器），输出 JSON
/usr/lib/electron41/electron scripts/probe-capabilities.cjs
```

---

## 9. 合规与边界

- 本应用是**网页版的浏览器外壳**，请求等价于浏览器访问，不修改加密请求、不调用未公开接口。
- **不绕过**登录、VIP、版权限制、DRM。用户能听什么完全取决于其账号在网页版的权限。
- **不**把网易的静态产物（约 8 MB JS/CSS）提交进公开仓库或对外分发包——那是其著作权代码。任何缓存目录写进 `.gitignore`。
- 图标是网易商标，**自用可以**；公开分发请换成自己的图标。
- 服务条款未明确允许第三方客户端，**自己用、不公开分发，风险最低**。

---

## 10. 参考：现成替代品

| 包名 | 说明 |
|---|---|
| `netease-cloud-music` (AUR) | 官方 Linux 客户端，从 .deb 转，1.2.1，较旧 |
| `yesplaymusic` (AUR) | 第三方 Electron + Vue，0.4.10 |
| `electron-netease-cloud-music` (archlinuxcn) | 非官方 Electron + Vue + Muse-UI，0.9.40 |
| `hydrogen-music` (AUR) | Electron + Vue 的明日方舟风格第三方播放器 |
| `go-musicfox` (AUR) | Go 写的 TUI 客户端，5.1.0 |
| `blurlyric` / `creamplayer` (AUR) | 其他第三方播放器 / 下载器 |

**为什么仍值得自己写**：可控（按 niri/DMS 习惯定制托盘与快捷键）、无第三方 API 服务依赖（`YesPlayMusic` 一类依赖自建 `NeteaseCloudMusicApi`，易失效）、以及「媒体键走 Chromium 原生管线」比任何 DOM 选择器方案都耐改版。

---

## 11. 附录：实现细节的坑

1. `sendInputEvent` 需 `keyDown` + `keyUp` 成对发，只发 `keyDown` 有些 handler 不触发。
2. `page-agent.js` 用 `<script>` 标签注入（`createElement('script')` + `textContent`）才跑在页面世界；`executeJavaScript` 也行但每次调用开销大，首屏注入一次常驻更合适。
3. `backgroundThrottling: false` 必须设，否则窗口隐藏后 `timeupdate` 被限流，MPRIS 进度卡住。
4. MPRIS 的 `mpris:artUrl` 需是可访问 URL；网易封面 URL 带时效参数，切歌时重新取，别缓存死。
5. `app.commandLine.appendSwitch` 必须在 `app.whenReady()` 之前调用。
6. Wayland 下 `--ozone-platform-hint=auto` 要在 appendSwitch 阶段加；托盘异常先试改 `x11`（XWayland）对比。
7. **EME 探测必须在安全上下文（HTTPS / localhost）**，`data:` URL 会假阴性。
8. EME 探测要区分「API 不存在」与「CDM 不支持」：前者报 `TypeError`，后者报 `NotSupportedError`。
9. 若日后启用 ECS，`components.whenReady()` 必须在建窗口前 `await`，且不能加 `--disable-component-update`。
10. **不要用 `protocol.handle('https')` 全量拦截来做页面注入。** 它是全有或全无的：注册后每个 https 请求都得自己转发一遍，于是踩两个坑 —— (a) 透传只传 URL（`net.fetch(req.url)`）会丢掉 method / headers / body，把所有 POST 降级成无 body 的 GET（登录二维码就是这么挂的：`POST /api/login/qrcode/unikey` 拿不到 unikey，`canvas` 空白）；(b) 重建 `Headers` 转发时，页面送来的非 Latin-1 请求头会让 undici 的 `Headers.set` 抛 ByteString 异常，而该异常发生在事件回调里、`try/catch` 抓不到，会直接打崩主进程弹出模态错误框。**正解是 CDP 注入**（`Page.addScriptToEvaluateOnNewDocument`），完全不碰网络。
11. 用 CDP 注入的两个细节：窗口必须先有一个文档（`loadURL('about:blank')`）再 `Page.enable`，否则命令永不返回；`debugger.on('detach')` 要重挂，否则后续导航不再注入。
12. 比对 web 版与客户端版的 bundle 时，**先统一 unicode 转义**：web 构建把非 ASCII 转义成 `\uXXXX`，客户端构建保留 UTF-8。直接做字面比对会得到假的低相似度（本次先算出 13%，解码后实际 95%）。另外两边的 chunk 切分不同（客户端含 `subApp`，`vendors~app` 只有 26 KB），只能按内容比、不能按文件名比。
13. 网易的下载 CDN（`d1.music.126.net` / `d8.music.126.net`）**校验 UA**：不带浏览器 UA 一律 403，看起来像"文件不存在"。探测文件是否存在时必须带 UA，否则会误判（本次第一轮探测 arm64 包全是 403 就是这个原因）。带 UA 后：存在返回 200，不存在返回 404。
14. `_arm64.dmg` 没有被下载页暴露（页面只有一个 `/api/osx/download/latest`，且它忽略 `?arch=` 参数，返回通用包）。arm64 版要靠文件名规律自己拼：把通用包名 `…_<版本>.dmg` 改成 `…_<版本>_arm64.dmg`。Windows 侧同理，UA 里带 `Win64` 时 `/download/pc/latest` 会 302 到 `_64.exe`。
15. **Arch 的 `electron` 是元包，不含任何文件**（`pacman -Si electron` 显示安装后大小 0.00 MiB，依赖 `electron43`），所以它**不提供 `/usr/bin/electron`**。版本化包只提供 `/usr/lib/electronNN/electron`。任何启动器都不能写 `exec electron`，必须绝对路径解析并带兜底（`arch/PKGBUILD` 的 wrapper 与 `scripts/dev-system-electron.sh` 都按「显式 electron41 → `/usr/lib/electron4*/electron` 通配 → PATH」的顺序解析）。0.1.0-1 就是因为写了 `exec electron` 而启动即失败。

---

## 12. 附：本次结论所依据的实测命令

```bash
# 1. 拉页面 + 资源清单
curl -sS -L 'https://music.163.com/st/webplayer' -o /tmp/webplayer.html
grep -oE 'static_public/[a-f0-9_]+' /tmp/webplayer.html | head -1

# 2. 拉三个 bundle 后做 DRM/EME/编解码器关键词扫描
B='https://s5.music.126.net/static_public/68aea63daca57500bb3fb4b6_68aea63daca57500bb3fb4b7'
curl -sS "$B/hybrid/app.4c9df986.js" -o /tmp/app.js
curl -sS "$B/hybrid/vendors~app.31d15e2d.js" -o /tmp/vendors.js
curl -sS "$B/vendor/@cloudmusic-desktop/vendors-rudio@0.1.x/vendors-rudio.pc-new.production.js" -o /tmp/rudio.js
grep -oF 'MediaKeys' /tmp/app.js /tmp/vendors.js /tmp/rudio.js | wc -l   # => 0
grep -oF 'requestMediaKeySystemAccess' /tmp/app.js /tmp/vendors.js /tmp/rudio.js | wc -l  # => 0
grep -oF 'new Audio' /tmp/app.js | wc -l                                 # => 8

# 3. 运行时 EME / 编解码器探测（隐藏窗口，安全上下文）
#    见 scripts/probe-capabilities.cjs，直接跑：
#    /usr/lib/electron41/electron scripts/probe-capabilities.cjs

# 4. 验证 HTTPS 拦截能否保住 origin / cookie（第 2.6 节的 B 方案）
#    关键点：handler 命中后返回本地 Response，其余用 net.fetch 透传（bypassCustomProtocolHandlers）。
#    实测输出：origin=https://music.163.com, isSecureContext=true, document.cookie 含 MUSIC_U。
#
#    await session.defaultSession.protocol.handle('https', async (req) => {
#      const u = new URL(req.url);
#      if (u.hostname === 'music.163.com' && u.pathname === '/st/webplayer') {
#        return new Response(localShellHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
#      }
#      return net.fetch(req.url, { bypassCustomProtocolHandlers: true });
#    });

# 5. 统计首屏 JS 请求数（评估镜像成本）
#    见下方 webRequest 日志思路；实测首屏 41 个 .js，其中约 35 个 hybrid/<id>.<hash>.js 懒加载 chunk。
```

---

## 13. 实施状态：Linux 骨架已可运行

用系统 Electron 跑，`npm start` 即可；无需下载 npm 版 electron。

| 模块 | 状态 | 说明 |
|---|---|---|
| `src/main.js` | ✅ | Wayland（`--ozone-platform-hint=auto`）、WM class、单实例、关窗进托盘、外链外开、断网兜底、UA 剥离、zoom、user.css |
| `src/config.js` | ✅ | `~/.config/netease-st/config.json`，默认值 + 深合并，首次运行写入 |
| `src/preload.js` + `src/page-agent.js` | ✅ | 注入壳 HTML 的 head 最前；截获不挂 DOM 的播放元素；CustomEvent ↔ IPC 桥 |
| `src/mpris.js` | ✅ | `org.mpris.MediaPlayer2.netease_st`；媒体键经 `sendInputEvent`，seek / volume 走直控 |
| `src/tray.js` | ✅ | 显示/隐藏、播放暂停、上一首、下一首、退出 |
| `src/assets/` | ✅ | 断网兜底页 + 512×512 图标（站点 favicon 转） |
| `arch/` | ✅ 可用 | PKGBUILD（依赖系统 electron）、`.desktop`（`StartupWMClass=netease-st`） |
| `scripts/dev-system-electron.sh` | ✅ | 自动解析系统 Electron，支持把脚本当入口跑 |

**实测（2026-09-11，niri + Wayland + Electron 41.10.7）**：

```
SMOKE_REPORT {
  "origin": "https://music.163.com",     ← 注入拦截后 origin 不变
  "agentReady": true,                     ← preload 桥 + page-agent 生效
  "stateCount": 2,                        ← 状态已上报
  "mpris": "org.mpris.MediaPlayer2.netease_st",
  "tray": true,
  "errors": []
}
```

- `busctl --user list` 可见 `org.mpris.MediaPlayer2.netease_st`
- `gdbus introspect` 可见 `Identity='网易云音乐'`、`PlaybackStatus`、`Metadata`、`Volume`、`Position` 及全套 Player 方法
- `gdbus call ... Player.PlayPause` 调用成功返回 `()`，已转发到页面

**注意**：未登录时 `agentHasAudio` 为 false —— 播放元素要等播放器初始化才创建，属正常；登录后播放一首即可看到状态与元数据。

**已修（架构简化）**：登录二维码不显示 —— 根因是「用 `protocol.handle('https')` 全量拦截来注入」这个设计本身：透传把 `POST /api/login/qrcode/unikey` 降级成了无 body 的 GET，二维码 `canvas` 拿不到 unikey。深追还发现全量转发会因非 Latin-1 请求头打崩主进程。**最终把注入改为 CDP 的 `Page.addScriptToEvaluateOnNewDocument`，不再拦截任何网络**。实测：`POST_UNIKEY => 200 {"code":200,"unikey":"..."}`、`agentHasAudio: true`、`navigator.webdriver: false`、`errors: []`。详见第 11 节第 11、12 条。

**暂缓未做**（见 2.7 / 2.8）：L1 host bridge（`Bridge` / `AudioPlayer`）、桌面歌词、迷你播放器、B 方案本地缓存、electron-builder 打包。第 8 节里程碑 M1–M3 基本达成；M4 只落了 PKGBUILD 与 `.desktop`，未实际 `makepkg` 验证。
