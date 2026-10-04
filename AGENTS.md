# AGENTS.md — AI 协作开发指南

面向在本仓库工作的 AI 编程助手（ZCode / Codex / Claude Code 等）与人类协作者。
README.md 面向最终用户；本文件回答「改代码的人需要知道什么」。

## 一句话架构

Tauri 2 桌面应用：**Rust 后端**（`src-tauri/src/`，~1 万行）做录音、ASR、LLM、
OCR、键盘/剪贴板注入、托盘与热键；**React 19 前端**（`src/`，~1.3 万行）是设置
主窗口（`index.html` → `App.tsx`）与跟随光标的悬浮窗（`overlay.html` →
`overlay.tsx` → `components/Overlay.tsx`）。两端只通过 Tauri `invoke` 命令与
`sn-*` 事件通信。

核心数据流：全局热键 → `pipeline.rs`（会话状态机）→ `audio.rs`（cpal/WASAPI
采集）→ `asr.rs`（云端）/`local_whisper.rs`/`qwen_asr.rs`（本地）→ `llm.rs`
（纠错/润色/翻译）→ `inject.rs`（剪贴板粘贴或模拟键盘输入）。

## 验证命令（改动后必跑）

```bash
npx tsc --noEmit            # 前端类型检查（strict，全库零 any，别开先例）
npm run contracts           # 前后端契约对账（见下），CI 同款
cd src-tauri
cargo check --lib --examples  # Rust 编译（含 5 个诊断 examples）
cargo test                    # 87 个单测（纯逻辑层：提示词/结构化翻译/文本清洗/CCC 状态机…）
```

前端 UI 可在纯浏览器迭代（无 Tauri、无 Rust）：`npm run dev` 后访问
`http://localhost:5173/?mock=1`。`src/dev/mock-tauri.ts` 拦截了全部 IPC，
控制台可用 `__mock.stage('recording')` / `__mock.emit('sn-llm-delta', {…})` /
`__mock.tab('mic')` 驱动任意界面状态。

**绿灯 ≠ 能跑**：全局热键、麦克风采集（WASAPI）、UIA 光标定位、按键注入、
剪贴板还原、截图 OCR 只能在真机 Windows 手测。改动这些区域后请提醒用户
`npm run tauri dev` 回归。`src-tauri/examples/`（anchorcheck / asrcheck /
devtest / sysvol / zhcheck）是这些硬件路径的独立诊断程序。

## 目录地图（README 未展开的部分）

| 路径 | 职责 |
|---|---|
| `src-tauri/src/lib.rs` | 40 个 `#[tauri::command]` 注册、`Ctx` 全局状态、窗口/单实例/提权重启接线 |
| `src-tauri/src/pipeline.rs` | 听写会话状态机：start/stop/run/finish_and_input、流式分段、热键串行执行线程（`post_*`） |
| `src-tauri/src/inject.rs` | 输出注入：剪贴板粘贴（含占用重试/还原/说话探测）、模拟键盘、UIPI 提权检测 |
| `src-tauri/src/caret.rs` | UIA COM 定位输入光标（悬浮窗跟随）+ 前台窗口信息 |
| `src-tauri/src/ccc.rs` | Ctrl+C+C 双击取词低级键盘钩子状态机 |
| `src-tauri/src/selection.rs` | 划词取词：UIA 无副作用通道 + 模拟 Ctrl+C 兜底 |
| `src-tauri/src/translate.rs` / `trans_struct.rs` | 划词/复制即翻译 + 结构化（i18n 文件）翻译，见 docs/translation.md |
| `src-tauri/src/ocr.rs` | 截图取词：每屏选区窗 + GDI 截屏 + Windows OCR / PP-OCR |
| `src-tauri/src/qwen_asr.rs` / `local_llm.rs` | llama.cpp sidecar 进程管理（下载/预热/Job Object 回收） |
| `src-tauri/src/display_api.rs` | 外接字幕屏 axum HTTP/WS 服务，见 docs/external-display-api.md |
| `src-tauri/src/events.rs` | 所有 `sn-*` 事件的统一发射出口 |
| `src/components/Overlay.tsx` | 悬浮窗全部卡片（听写/翻译/OCR/审阅/错误），2000+ 行，改动画注意各卡互斥条件 |
| `src/dev/mock-tauri.ts` | 浏览器 mock 层（`?mock=1`），新增命令/事件须同步补 mock |

## 三条契约（改一侧必须同步另一侧，CI 用 `npm run contracts` 门禁）

1. **配置结构**：`src/types.ts` 的 interface 手工镜像 `src-tauri/src/config.rs`
   的 `#[serde(rename_all = "camelCase")]` struct。新增字段：Rust 加字段
   （`#[serde(default)]` 保证旧配置可读）→ types.ts 加同名字段 → mock 的
   `mockConfig` 视需要补默认值。
2. **事件名**：Rust `events::emit(app, "sn-xxx", …)` / `app.emit("sn-xxx", …)`，
   前端 `listen('sn-xxx', …)`。纯字符串、编译期不查拼写，脚本对账。
3. **命令名**：前端 `invoke('xxx')` ↔ `lib.rs` 的 `generate_handler![...]`
   列表。新增命令：写 `#[tauri::command]` → 注册进列表 → `api.ts` 加类型化
  封装 → mock 补 case。

## 危险区（改动前停一秒）

- **unsafe 集中地**：`win_volume.rs`（CoreAudio COM）、`caret.rs` /
  `selection.rs` / `inject.rs`（UIA/剪贴板/SendInput）、`ccc.rs`（低级键盘
  钩子）、`qwen_asr.rs`（`unsafe impl Send`）。COM 调用注意套间：OCR 识别
  主动 `CoInitializeEx(MTA)`（ocr.rs 注释），新加 COM 路径先看同文件先例。
- **线程模型**：热键/托盘回调在主线程，重活必须走 `pipeline::post_*` 或
  `spawn_blocking`（历史上主线程被 WASAPI 开流阻塞导致「保存卡住」）。
  `save_config` 的快捷键重注册也必须留在后台线程。
- **进程管理**：llama.cpp sidecar 常驻可达 ~10GB 提交内存，启停只能经
  `ensure_server` / `shutdown`（带 Job Object 与孤儿清理），不要直接 spawn。
- **写盘/删除**：`config::save` 之外不要新造配置写点；`delete_builtin` 会
  删模型目录，路径拼接改动需极度小心。
- **提权**：`restart_elevated`（UAC 重启）与 `--elevated-relay` 中继逻辑，
  改错会双重实例或拒绝启动。
- **剪贴板**：粘贴注入有 PASTE_LOCK 串行化 + 校验 + 还原三重逻辑，动它先读
  `inject.rs` 头部注释，历史上这里出过「串话」「旧内容覆盖」事故。

## 约定

- 注释写「为什么」而不是「做什么」，中文，与现状一致。
- 生产代码禁止 `unwrap()/expect()`（测试模块除外）；Mutex 一律
  `lock().unwrap_or_else(PoisonError::into_inner)`。
- 前端零 `any`；`invoke<T>` 必须带泛型。
- commit 遵循 conventional 风格（`feat:` / `fix:` / `ci:` / `release:`），
  中文描述。

## 发版（自动发布，流程细节在 .github/workflows/ci.yml 头部注释）

1. `src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml` 三处
   版本号同步改（CI 第一步强校验）；
2. `CHANGELOG.md` 加对应 `## vX.Y.Z（日期）` 段落（缺段落 extract-changelog
   会报错退出）；
3. push 到 main，CI 自动构建并发布 Windows NSIS + macOS DMG 到 GitHub Release。

## 版本

SpeakNow v0.4.10 · Windows 优先（macOS 部分功能受限，见 docs/macos.md）
