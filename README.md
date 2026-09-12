# netease-st

网易云音乐**网页版**（`https://music.163.com/st/webplayer`）的 Linux Electron 桌面壳。

页面始终从线上加载，origin 保持 `https://music.163.com`，登录 / cookie / 接口天然正确；
桌面集成（MPRIS、媒体键、托盘、关窗进托盘、Wayland）由 preload + 主进程完成。

设计与实测依据见 [DESIGN.md](./DESIGN.md)。

## 依赖

Arch：

```bash
sudo pacman -S electron41 libayatana-appindicator
```

注意**不要装 `electron`**：那是个元包（依赖 `electron43`），而且不含任何文件，不提供 `/usr/bin/electron`。Arch 的版本化包只提供 `/usr/lib/electronNN/electron`，所以启动器必须走绝对路径解析（`arch/PKGBUILD` 里已处理）。

其他发行版：需要 Electron ≥ 28（实测 41.10.7 与 42.9.3 均可）与 AppIndicator 支持库。

本项目**不下载** npm 版 electron（省 ~100MB），直接用系统 Electron。

## 运行

```bash
npm install          # 只装 mpris-service（纯 JS，无原生编译）
npm start            # 正常启动
npm run smoke        # 隐藏窗口冒烟测试，16s 后打印诊断并退出
npm run probe        # EME + 音频编解码器能力矩阵
```

## 配置

首次运行会写入 `~/.config/netease-st/config.json`（默认值见 `src/config.js`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `https://music.163.com/st/webplayer` | 目标页 |
| `closeToTray` | `true` | 关窗进托盘而不是退出（继续放歌） |
| `tray` | `true` | 托盘；niri 下不显示就装 `libayatana-appindicator` |
| `globalShortcuts` | `false` | **保持 false** —— niri/DMS 已接管媒体键，再抢会双触发 |
| `stripElectronUA` | `true` | 剥离 `Electron/x` 标识，伪装普通 Chrome |
| `waylandNative` | `true` | `--ozone-platform-hint=auto` |
| `disableGpu` | `false` | Wayland 渲染异常的逃生门 |
| `zoom` | `1.0` | 缩放 |
| `userCss` | `true` | 注入 `~/.config/netease-st/user.css`（文件变化自动重载） |

## 桌面集成

- **MPRIS**：总线名 `org.mpris.MediaPlayer2.netease_st`
- **媒体键**：走 Chromium 原生输入管线 `sendInputEvent`（`MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop`），直达页面自己的 `navigator.mediaSession` handler，**不依赖任何 DOM 选择器**，站点改版不会失效
- **seek / volume**：媒体键覆盖不到，直接控制播放元素（`zmusic:cmd`）
- **窗口**：`StartupWMClass=netease-st`，与 `.desktop` 对齐，niri/DMS 图标正确
- **单实例**：重复启动只会把已有窗口带到前台，不会开出第二个应用

## 验收 / 排障

```bash
# 冒烟：不弹窗，打印 origin / agent / MPRIS / tray 诊断
npm run smoke

# MPRIS 是否注册
busctl --user list | grep netease
gdbus introspect --session --dest org.mpris.MediaPlayer2.netease_st --object-path /org/mpris/MediaPlayer2

# 通过 D-Bus 触发播放暂停（应转发到页面）
gdbus call --session --dest org.mpris.MediaPlayer2.netease_st \
  --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.PlayPause

# 用某个脚本当入口跑
bash scripts/dev-system-electron.sh scripts/probe-capabilities.cjs
```

常见问题：

- **托盘不显示**：装 `libayatana-appindicator`；仍不行把配置 `tray` 设为 `false`，退化为仅 MPRIS。
- **偶发 `ERR_NAME_NOT_RESOLVED`**：网易部分域名只解析到 IPv6，网络抖动时会失败；不影响主流程。
- **`agentHasAudio` 为 false**：未登录 / 未播放时不创建播放元素，属正常。
- **`/usr/bin/netease-st: exec: electron: 未找到`**：0.1.0-1 的启动器写死了 `exec electron`，而 Arch 没有这个路径。0.1.0-2 已改为按 `/usr/lib/electron41/electron` 解析并带兜底。重新构建安装即可：

  ```bash
  cd arch && makepkg -si      # 或 makepkg -f && sudo pacman -U netease-st-0.1.0-2-any.pkg.tar.zst
  ```

## 目录

```
src/
├── main.js          # 窗口 / 生命周期 / 单实例 / CDP 注入 / 托盘 / MPRIS 接线
├── config.js        # 配置默认值 + 深合并
├── preload.js       # 隔离世界：DOM CustomEvent ↔ IPC
├── page-agent.js    # 注入页面主世界：截获播放元素 + 状态上报 + 命令下行
├── mpris.js         # MPRIS over D-Bus
├── tray.js          # 托盘
├── l1/              # 【暂缓】L1 注入层原型（见 DESIGN.md 2.8）
└── assets/          # 图标、断网兜底页
arch/                # Arch 打包：PKGBUILD + .desktop（依赖系统 electron）
scripts/             # 系统 Electron 启动脚本、能力探测
```

## 暂缓未做

L1 host bridge（`Bridge` / `AudioPlayer`，可解锁桌面歌词、迷你播放器）、B 方案本地缓存加速、
electron-builder 打包。相关结论与实测都在 DESIGN.md 的 2.6 / 2.7 / 2.8 节。

## 合规

本应用是网页版的浏览器外壳，请求等价于浏览器访问，不修改加密请求、不调用未公开接口，
**不绕过**登录、VIP、版权限制与 DRM。自用、不公开分发，风险最低。
