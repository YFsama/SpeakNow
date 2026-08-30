# SpeakNow 🎤

**快捷键语音输入助手** —— 在任何输入框（Codex / ZCode / 浏览器 / 微信 / 终端…）中，按住或按下全局快捷键说话，自动完成：

```
按快捷键 → 录音 → ASR 转写（云端 / 本地离线）→ AI 纠错润色（可选）→ 自动输入到光标处
```

基于 **Tauri 2（Rust）+ React 19 + Vite + Tailwind CSS 4** 构建。Windows 优先，安装包小、内存占用低、常驻托盘即按即说。

![平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![框架](https://img.shields.io/badge/Tauri-2-orange)
![ASR](https://img.shields.io/badge/ASR-MiMo%20%7C%20GLM%20%7C%20Whisper%20%7C%20Qwen3--ASR-green)

## ✨ 功能特性

### 触发与输入

- **全局快捷键**：默认 `Ctrl+Shift+Space`，支持「按一下开始/结束」与「按住说话」两种模式，可改绑任意组合键
- **快速模式第二快捷键**：跳过 AI 优化直接输出原文，追求极致速度
- **静音自动结束（VAD）**：检测到停止说话自动收音，可调灵敏度与静音时长
- **自动输入**：默认剪贴板粘贴（瞬时、支持多行、**自动还原剪贴板内容**），可选模拟键盘逐字输入；可自动回车提交；老式终端可切 `Shift+Insert`
- **预览编辑模式**：可选「输入前确认」——结果先显示在悬浮窗中，可手动编辑、重新 AI 优化，再确认输入

### 语音识别（四种引擎任选）

| 引擎 | 类型 | 体积 | 特点 |
|---|---|---|---|
| **MiMo 云端** | 云端 | — | 小米 MiMo-V2.5-ASR，中文效果好、免部署 |
| **云端 API** | 云端 | — | GLM-ASR / Groq Whisper / OpenAI / SiliconFlow 预设，或任意 OpenAI 兼容接口与自建 whisper.cpp 服务 |
| **本地 Whisper** | 离线 | 42MB 起 | 纯 Rust（candle）推理，零 Key 零联网；Tiny 量化 42MB / Base 291MB（推荐）/ Small 967MB |
| **Qwen3-ASR 1.7B** | 离线 | 约 2.4GB | 新一代高精度中文离线（llama.cpp 引擎），普通话字错率约 5%，GPU 上单句延迟约 0.4 秒 |

- **Qwen3-ASR 离线引擎**：
  - 模型与 llama.cpp 运行时**一键下载**，官方 HuggingFace 源直连
  - 自动检测显卡选择 **Vulkan（GPU 加速）** 或 CPU 构建；Vulkan 启动失败自动回退 CPU
  - 应用启动即后台预热引擎，按快捷键秒级响应；异常残留进程自动接管
- **ASR 热词**（行业字库）：GLM-ASR 等支持最多 100 个热词，专有名词识别率显著提升
- **边说边出字（流式分段）**：说话期间按停顿自动分段识别，字幕实时上屏，说完即出全文
- **语气词清理**：自动去除「嗯 / 呃 / yeah」等口头音与呼吸声幻觉
- **长语音自动分段**：云端 30 秒限制自动按 28s 分段拼接，网络抖动自动重试

### AI 纠错与优化

- 转写结果再经大模型处理：**GLM / DeepSeek / Kimi / OpenAI** 预设，以及**本地 Ollama / LM Studio / llama.cpp（免 Key）**，可一键拉取本机模型列表
- 三种模式：**仅纠错**（修同音字与标点）/ **纠错 + 润色**（整理为书面表达）/ **优化为编程提示词**（把口述整理成给 Codex/AI 的高质量指令）
- 支持自定义术语表与完全自定义指令模板（`{text}` 占位符）

### 悬浮窗（跟随光标）

- 识别过程中**自动跟随输入光标位置**的毛玻璃悬浮窗：录音电平条 → 实时字幕 → AI 优化终稿（词级 diff 高亮）→ 自动收起
- 鼠标悬停暂停阅读；可手动拖动固定位置；多显示器自动跟随

### 外接显示（硬件字幕屏）· 预留 API

- 把聆听窗口的实时字幕推送到**外接硬件**：平板、树莓派、副屏电脑……浏览器打开 `http://<本机IP>:8866/display` 即是一块字幕屏（支持 `?scale=` 放大字号）
- 可选**隐藏本地悬浮窗**：字幕只在外接硬件上显示，本机完全静默
- 预留 **WebSocket API**（`/api/events`，版本化信封 `{v, type, data, ts}`）供客户自研硬件接入，详见 [docs/external-display-api.md](docs/external-display-api.md)
- 默认仅本机可连；勾选「允许局域网设备」后同一网络的硬件均可访问

### 麦克风深度调校

- 列出系统全部输入设备（规格 / 默认标记），DJI Mic、USB 麦、内置麦均可
- **单设备快测**（1.4s 电平统计）、**完整测试**（3s 采集 + 实时波形 + 录音回放试听）
- **全设备同测**：一次说话对比所有端点哪个真正有声音
- **系统音量 / 硬件增益（Mic Boost）**直接读写，立即生效；**自动增益校准**一键建议软件增益
- **增益按设备记忆**：切换麦克风自动换入该设备自己的增益，互不干扰；新设备首次选用时自动校准一次
- **录音自动增益（AGC）**：说话声过小且确有语音时自动逐步提升、接近削波自动回落；学到的增益按设备记住，下次录音直接生效（可关闭）
- Windows 麦克风隐私授权状态自检

### 其他

- **设置即改即存**：修改 800ms 后自动保存并即时生效（含保存看门狗，异常自动重试，不会卡在「正在保存」）
- **历史记录**：最近 50 条，支持搜索、原文/终稿对比、按当前设置重新优化、单条删除、导出 txt
- **使用统计**：累计/今日次数、字数、平均耗时
- 开机自启、关闭驻留托盘、录音提示音、深浅主题、界面缩放
- 误触快捷键（<0.8s）自动忽略；完成卡提示 `Ctrl+Z` 可撤销

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | |
| Rust | stable | `rustup` 安装；Windows 需 MSVC 工具链（VS Build Tools），macOS 需 Xcode CLT |
| WebView2 | — | Windows 10/11 一般已内置 |

### 开发运行

```bash
npm install
npm run tauri dev
```

> 注意：`tauri dev`（Debug 构建）下本地 Whisper 推理比 Release 慢 10 倍以上，测本地引擎请用 Release。

### 打包成品

```bash
npm run tauri build            # Windows 下生成 NSIS 安装包
```

产物位置：

- 安装包：`src-tauri/target/release/bundle/nsis/SpeakNow_0.4.5_x64-setup.exe`
- 绿色单文件：`src-tauri/target/release/speaknow.exe`（免安装直接运行）

版本历史与各版本变更详见 [CHANGELOG.md](./CHANGELOG.md)（应用内「关于」页也可查看更新记录）。

## 📖 使用说明

1. 首次启动后在「语音识别」选择引擎：
   - **MiMo / 云端 API**：填入 API Key，点「测试连接」验证（推荐[智谱开放平台](https://bigmodel.cn)，一个 Key 同时用于 GLM-ASR 与 GLM 纠错）
   - **本地离线**：在模型卡片点「↓ 下载」（Whisper Base 291MB 起步；追求中文准确率选 Qwen3-ASR，需约 2.4GB 磁盘与 8GB+ 内存，有 NVIDIA/AAMD/Intel 独显会自动启用 GPU 加速）
2. 「AI 优化」可选开启并配置模型（无 Key 可用本地 Ollama：先 `ollama pull qwen3:4b`）
3. 「麦克风」选择设备并测试电平（无线麦建议跑一次「自动校准」）
4. 打开任意输入框 → `Ctrl+Shift+Space` 说话 → 松开/再按一下 → 文字自动输入

### 隐私说明

- 本地离线模式下，语音与文字**完全不出本机**
- API Key 仅保存在本机配置文件，只发送给你自己配置的服务商
- 历史记录仅存本机，可随时删除

## ⚙️ 工作原理

```
┌─────────────────────── Rust (Tauri 2) ────────────────────────┐
│ cpal 采集 ─→ 重采样16k/分段 ─→ ASR（reqwest / candle / llama.cpp）│
│ 全局热键    VAD 静音检测        MiMo · GLM · Whisper · Qwen3    │
│ LLM 优化（OpenAI 兼容 / Ollama）  arboard 剪贴板（用后还原）      │
│ 光标定位（UIA）→ 悬浮窗跟随      enigo 按键模拟（粘贴/输入）       │
└─────────────────────────┬────────────────────────────────────┘
                          │ Tauri events
┌───────────── React 19 主窗口 / 悬浮窗 ─────────────────────────┐
│   设置页（自动保存） · 光标跟随悬浮窗 · 历史与统计                 │
└────────────────────────────────────────────────────────────────┘
```

### 数据目录

配置与数据保存在 `%APPDATA%\com.speaknow.app\`（macOS：`~/Library/Application Support/com.speaknow.app/`）：

| 文件/目录 | 内容 |
|---|---|
| `config.json` | 全部设置（含 API Key）。原子写入：进程被强杀也不会损坏 |
| `config.bak` | 上一份完好配置；主文件意外损坏时自动从备份恢复 |
| `config.corrupt` | 若出现，是当时解析失败的主文件留档（可手动找回内容） |
| `history.json` | 历史记录（最近 50 条），同样原子写入 |
| `models\` | 本地模型（Whisper GGUF / Qwen3-ASR GGUF） |
| `llama-runtime\` | llama.cpp 运行时（Qwen3-ASR 引擎） |
| `save-trace.log` | 设置保存链路追踪（诊断用，自动截断） |
| `pipeline.log` | 每次听写的流程追踪（录音/识别耗时/吞吐/输入结果，诊断用，自动截断） |

## 📁 项目结构

```
SpeakNow/
├─ src/                        # 前端（React 19 + Tailwind 4）
│  ├─ App.tsx                  #   设置主窗口：配置状态、自动保存、事件接线
│  ├─ overlay.tsx / components/Overlay.tsx   # 光标跟随悬浮窗
│  └─ components/sections.tsx  #   各设置页（麦克风/识别/优化/输出/关于…）
├─ src-tauri/src/              # 后端（Rust）
│  ├─ lib.rs                   #   命令注册、提权重启、单实例
│  ├─ pipeline.rs              #   听写全流程编排（热键→录音→识别→优化→输入）
│  ├─ audio.rs                 #   cpal 采集、VAD、增益、设备诊断
│  ├─ asr.rs / local_whisper.rs / qwen_asr.rs   # 云端 / Whisper / Qwen3 引擎
│  ├─ llm.rs                   #   AI 纠错优化（OpenAI 兼容，SSE 流式）
│  ├─ inject.rs                #   剪贴板校验、按键注入、终端/管理员窗口适配
│  ├─ config.rs / history.rs   #   原子写入配置与历史
│  └─ overlay.rs / caret.rs    #   悬浮窗定位（UIA 光标锚点）
├─ src-tauri/examples/         # 独立诊断小程序（锚点/识别/回环测试等）
└─ scripts/gen-icons.mjs       # 应用图标生成
```

## ❓ 常见问题

- **Qwen3-ASR 下载慢？** 它始终走 HuggingFace 官方源直连（约 2.4GB）；「下载镜像」设置仅作用于 Whisper 系列模型。
- **没有独立显卡？** Qwen3-ASR 自动使用 CPU 构建，可用但速度一般；建议改用本地 Whisper Base 或云端引擎。
- **WSL / 终端里自动输入无效？** 粘贴按键选「自动」（默认）：Windows Terminal / WSL 等 Unix 风格终端自动用 `Ctrl+Shift+V`，传统控制台用 `Shift+Insert`；输入前会等松开快捷键修饰键，避免注入成 `Ctrl+Shift+V`。若终端以管理员运行而本应用不是，系统（UIPI）会阻止按键注入——此时报错会标明拦截进程（如 `WindowsTerminal.exe`），点报错里的「🛡 以管理员身份重启」一键提权即可（设置 · 输出页也有常驻入口）。
- **修改快捷键后未生效？** 快捷键变化会在后台重注册，若被其他应用占用会在托盘日志中提示，换个组合即可。

## 🗺️ Roadmap

- [x] 流式分段识别（边说边出字）
- [x] 光标跟随悬浮窗
- [x] 本地离线识别（Whisper / Qwen3-ASR）
- [ ] 轻量中文离线引擎 SenseVoice-Small（235MB，CPU 友好）
- [ ] 流式 TTS 朗读校对
- [ ] Linux 支持

## License

[MIT](./LICENSE) © SpeakNow Contributors
