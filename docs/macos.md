# macOS 构建与使用

SpeakNow 的核心链路（cpal 采集、全局热键、ASR / LLM 请求、剪贴板粘贴）都是跨平台实现，macOS 开箱即用；少数 Windows 专属能力做了优雅降级（见文末差异表）。

## 获取安装包（推荐）

CI 在每次发版时同时构建 Windows 安装包与 **macOS（Apple Silicon, aarch64）DMG**，到 [Releases](https://github.com/YFsama/SpeakNow/releases) 下载 `SpeakNow_x.x.x_aarch64.dmg`，拖入「应用程序」即可。

Intel Mac（x86_64）暂无官方产物，用下方源码构建（约 10 分钟）。

### 首次运行：绕过 Gatekeeper

CI 产物未做开发者签名与公证，首次打开会被 Gatekeeper 拦截。任选其一：

- 在「应用程序」里 **右键 → 打开 → 再点「打开」**（只需一次），或
- 终端执行：`xattr -cr /Applications/SpeakNow.app`

### 首次运行：系统权限

按弹窗提示授权（路径：系统设置 → 隐私与安全性）：

| 权限 | 用途 | 时机 |
|---|---|---|
| **麦克风** | 采集语音（Info.plist 已声明用途） | 首次录音 |
| **辅助功能（Accessibility）** | 全局快捷键监听 + 模拟 ⌘V 粘贴 / 键入 | 首次按下快捷键时 |
| **输入监控（Input Monitoring）** | 部分系统版本上 enigo 需要它模拟按键 | 视系统提示 |

授权辅助功能后如仍无响应，重启一次应用让权限生效。

## 源码构建

```bash
# 1. 依赖：Xcode 命令行工具 + Rust + Node ≥ 20
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. 构建（Apple Silicon 直接构建；Intel Mac 加 --target x86_64-apple-darwin）
npm install
npm run tauri build

# 3. 产物
open src-tauri/target/release/bundle/dmg/     # .dmg 安装包
open src-tauri/target/release/bundle/macos/   # 或直接运行 .app
```

开发调试：`npm run tauri dev`（注意 Debug 构建下本地模型推理慢 10 倍以上，测本地引擎请用 Release）。

## 平台差异

| 能力 | Windows | macOS |
|---|---|---|
| 录音 / ASR / AI 优化 / 历史统计 | ✅ | ✅ |
| 剪贴板粘贴 | `Ctrl+V`，终端自动切 `Ctrl+Shift+V` / `Shift+Insert` | 自动使用 `⌘V` |
| 悬浮窗锚点跟随光标（UIA） | ✅ | 降级为默认位置显示 |
| 系统麦克风音量读取/调节 | ✅ | 不支持（软件增益仍可用） |
| 「终端键入」输出模式 | ✅ | 不适用（Mac 终端均支持 ⌘V） |
| 管理员提权（UIPI）相关 | ✅ | 不适用 |
| 本地 Whisper / Qwen3-ASR | 可启用 GPU 加速 | CPU 推理，较慢；Mac 上建议用云端 ASR |

配置与数据目录：`~/Library/Application Support/com.speaknow.app/`。
