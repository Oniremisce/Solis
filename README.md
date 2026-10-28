# Solis

Android TV 音乐播放器，内容源为汽水音乐，配套自建 API 代理服务端。
16:9 大屏 UI、莫奈逐字歌词、遥控器全键盘操控。

## 项目构成

| 目录 | 说明 |
|---|---|
| `Solis/` | TV 客户端：React 18 + TypeScript + Vite 构建，Capacitor 打包 Android WebView 壳 |
| `qishui-api/` | API 服务端：Node.js 代理汽水接口（音频直链解析、登录态、FM 推荐流等） |

服务端基于开源项目 [qishui-api](https://github.com/guowenye/qishui-api)（MIT License），本仓库收录部署所需源码，详见其自带 [README](qishui-api/README.md)。

## 客户端特性

- 三种 FM 推荐模式（默认 / 熟悉 / 新鲜），队列耗尽自动续拉
- 歌单、搜索、收藏、音质徽章（Hi-Res / 全景声 / 无损 / 高品质）
- 莫奈逐字歌词：弹性滚动轨道 + 逐字扫色染色，seek 即时对齐
- 双播放器会话架构：FM 与歌单各持独立 `<audio>` 元素，面板切换零加载等待、进度互不干扰
- TV 遥控器 DPAD 完整操控：焦点分组、焦点记忆、长按快进快退
- 返回键栈式浮层管理：浮层逐层关闭，无浮层时最小化到后台

## 客户端构建

依赖：Node.js 20+、JDK 21、Android SDK。

```bash
cd Solis
npm ci

# 配置服务端地址（局域网内部署示例）
cp .env.example .env.local
#   VITE_QISHUI_API_BASE=http://<服务端IP>:3300

npm run build
npm run cap:sync:android

# 打包 APK（需 JAVA_HOME 指向 JDK 21）
cd android
./gradlew assembleDebug        # Windows 用 gradlew.bat
# 产物：android/app/build/outputs/apk/debug/*.apk
```

版本号约定：每次打包前递增 `Solis/android/build-number.txt`，
`versionName` 随之为 `<semver>-b<构建号>`。

## 服务端运行

```bash
cd qishui-api
npm ci
cp .env.example .env   # 按需修改端口与配置
node server.js          # 默认监听 0.0.0.0:3300
```

客户端通过 `VITE_QISHUI_API_BASE` 指向服务端地址；电视与服务端需在同一局域网内可达。
音频流地址由服务端按请求 Host 动态拼接，无需额外配置。

### 关于 `signer/security/` 目录

`qishui-api/signer/security/` 内的 `bdms.js`、`sdk-glue.js`、`security_host.html` 等文件
是从汽水音乐网页端提取的**字节跳动专有签名 SDK**，因版权原因**不随本仓库分发**（已从版本库移除）。

运行本地签名服务（`qishui-api/signer/signer-server.mjs`，监听 `127.0.0.1:8899`）需要该目录；
请自行从汽水音乐网页端提取对应文件放入 `qishui-api/signer/security/`，勿将其提交到任何公开仓库。

## TV 遥控器键位

| 按键 | 行为 |
|---|---|
| OK / 确认 | 播放 / 暂停；焦点项打开 |
| 上 / 下 | 焦点移动（按分组循环） |
| 左 / 右 | 焦点移动；播放页长按 = 快退 / 快进（挡位可设置） |
| 上一曲 / 下一曲 | 短按切歌 |
| 菜单 | 设置 |
| 返回 | 关闭浮层；无浮层时最小化到后台 |

## 免责声明

本项目仅供个人学习交流使用；下载、解密与解析能力仅用于已获得合法授权的内容；
商用、传播、批量抓取、版权规避等风险由使用者自行承担（详见 [qishui-api/README.md](qishui-api/README.md)）。

## License

- 客户端 `Solis/`：AGPL-3.0（见 [Solis/LICENSE](Solis/LICENSE)）
- 服务端 `qishui-api/`：MIT（见 [qishui-api/LICENSE](qishui-api/LICENSE)）
