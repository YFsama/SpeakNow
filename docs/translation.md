# SpeakNow 翻译功能设计（DeepL 式本地客户端）

> 调研时间 2026-09。基于三路并行调研：代码架构盘点 / 翻译技术方案对比 / DeepL 式客户端交互与开源实现调研。

## 0. TL;DR

- **已有资产**：SpeakNow 已具备"听写翻译"（`llm.mode == "translate"`、专用热键 `key_translate`、托盘语言子菜单、翻译 prompt / 术语表 / 双语输出 / 思考-token 快路径全部就绪）。缺的是 DeepL 客户端的核心体验：**划词取词 → 独立翻译结果窗 → 复制/替换写回**，以及长文档批量翻译。
- **质量结论（2026）**：云端 LLM 翻译已全面超过 DeepL/Google（WMT25 上 Gemini 2.5 Pro 拿下 15 个语言对中的 14 个；中文系模型在 zh↔en 上有语料优势）。本地侧翻译专用小模型 **TranslateGemma-4B**（Q4 约 2.5–3GB）质量已超过传统 MT 引擎。"本地实现"完全成立，但建议做成**可选下载包**而非内置。
- **推荐架构**：云为主（复用现有 OpenAI 兼容 LLM 通道，零新增依赖）+ 本地增强包（llama.cpp sidecar 跑 TranslateGemma-4B，完全复用 `qwen_asr.rs` 的子进程管理模式）+ 统一的取词/展示/写回管线。
- **唯一需要从零建的模块**：跨应用取词（selection）。Windows 上 `caret.rs` 已经在用 UIA `GetSelection` 拿选区矩形——只差对同一个 range 调 `GetText()`，零新依赖。

---

## 1. 翻译引擎选型（调研结论）

### 1.1 质量与成本排序（zh↔en 主视角）

| 方案 | 质量 | 成本（100 万字） | 延迟 | 离线 | 集成成本 | 体积 |
|---|---|---|---|---|---|---|
| 云端旗舰 LLM（Gemini/Claude/GPT） | ★★★★★ | $5–20 | 1–3s 首字 | ✗ | **已有**（OpenAI 兼容客户端） | 0 |
| 云端性价比 LLM（DeepSeek/GLM/Qwen） | ★★★★☆ | ≈$1–2 | 1–2s | ✗ | **已有** | 0 |
| qwen-mt-turbo（阿里翻译专用 API） | ★★★★ | ≈$1–2 | <1s | ✗ | OpenAI 兼容 + `translation_options`（术语/领域/翻译记忆原生参数） | 0 |
| DeepL API | ★★★☆（欧语强、zh 一般） | ≈$25（贵 10–20 倍） | <1s | ✗ | 需单独 REST 模块 | 0 |
| 火山（200 万字/月免费）/ 腾讯（500 万/月免费） | ★★★ | 0 | <1s | ✗ | REST + 签名 | 0 |
| **本地 TranslateGemma-4B Q4** | ★★★★（超 DeepL 档，COMET 81.6） | 0 | CPU 7–15 tok/s；GPU 快 | ✓ | sidecar + OpenAI 兼容端口（复用现有客户端） | ~2.5–3GB + 10MB |
| 本地 Qwen3-4B/8B | ★★★☆ / ★★★★（8B 需 GPU） | 0 | 8B CPU 仅 3–6 tok/s | ✓ | 同上 | 2.5/5GB |
| 本地 NLLB-600M int8（ct2rs） | ★★☆（看大意） | 0 | 百 ms 级/句 | ✓ | ct2rs 进程内（需 C++ 工具链） | ~0.6GB |
| opus-mt / Argos | ★★（2020 水平，不推荐主力） | 0 | 快 | ✓ | ct2rs | ~300MB/对 |

依据：WMT24/WMT25 人类评测（WMT25 上 Gemini 2.5 Pro 14/15 语言对第一，Claude 3.5 Sonnet 为 WMT24 冠军，商业 MT 引擎已沦为 mid-tier）；TranslateGemma 官方 COMET（WMT24++ 55 语言：4B=81.6 / 12B=83.5 / 27B=84.4）；Alconost 5632 次真实项目评测（中文训练的模型在简中领先）。

### 1.2 对"大量翻译"有效的提示词技术（实测有据者）

| 技术 | 结论 | 对应实现 |
|---|---|---|
| 角色 + 领域声明 | 产业共识有效 | 已有（llm.rs 翻译 system prompt）；qwen-mt 的 `domains` 是官方化实现 |
| **术语表**（只注入当前 chunk 命中的条目） | ACL 2025 证实提升质量与一致性 | **已有** `glossary` 字段与 `apply_alias_fixes` 确定性替换；文档模式需改为检索式注入 |
| 反思/两遍审校 | 有效但成本 ×2–3 | 做成用户开关（精品档） |
| 少样本 few-shot | 选例好才有增益 | 低优先级，可不做 |
| Long-CoT 思考 | 对翻译收益不稳且拖慢 | **已处理**（翻译模式首轮关思考的 fast path 已存在） |

### 1.3 长文档管线（业界共识：pot / 沉浸式翻译 / 学术三方一致）

句/段自然边界分块（300–800 token，绝不字符硬切）→ 每 chunk 附"前 1–2 句已译文 + 风格说明"（滑动窗口上下文）→ 术语检索注入 → 3–8 并发流式回填 → 双语对照 UI → 句对 hash 翻译记忆（重复句零成本）→ 失败单块重试。格式保真：Markdown 用标签保护（code/URL）译后还原；DOCX 做段落级替换；PDF 不做原版式回填，走"解析→双语对照重排"。

---

## 2. DeepL 客户端交互拆解（用户故事）

| # | 用户故事 | 实现机制（DeepL 实际做法） |
|---|---|---|
| US-1 | 划词后 **Ctrl+C+C**（按住 Ctrl 快按两次 C）→ 小窗出译文 | 低级键盘钩子 + 手势识别；第一次 C 是正常复制，第二次触发读剪贴板。Brave 某版本会拦截；普通快捷键注册不了这种组合 |
| US-2 | 选中后点**浮动图标**触发 | 鼠标划选检测 |
| US-3 | "翻译/改进我的文字" | 官方是把文本带回应用内处理；开源工具（Bob/STranslate/uTools）的"替换原文"都是**显式操作**——我们也做成显式按钮 |
| US-4 | 展示方式可配置（小浮窗 / 主窗口）；**按应用禁用快捷键**黑名单 | 防终端/密码管理器误触发的关键细节，值得抄 |
| US-5 | 拖拽文件翻译（docx/pptx/pdf…，保留排版） | 完整产品线，分期做 |
| US-6 | 术语表管理（CSV 导入导出） | LLM 通道天然好做 |
| US-7 | 截图 OCR 翻译兜底（Ctrl+F8） | 划词失败时 OCR 兜底是 DeepL/Easydict/STranslate/pot 全员的标配 |
| US-8 | 正式/非正式语气、目标语言持久化 | 简单 |

### 开源先例（架构参考）

- **pot-desktop**（Tauri 1.x + Rust，19.4k stars，**2026-09 已归档且 GPL-3.0**）：取词独立成 crate——Windows 优先 UIA TextPattern，降级 enigo Ctrl+C + `GetClipboardSequenceNumber` 校验 + 100ms 短重试 + 剪贴板 (text,image) 备份还原；macOS 优先 AX `kAXSelectedText`，降级 osascript 模拟 Cmd+C（临时静音系统 beep、`changeCount` 校验、剪贴板还原）。剪贴板监听模式 = 500ms 轮询比对。服务全部插件化（`.potext`），多引擎并排。**借鉴思路、自己重写（GPL 传染）**。
- **Easydict**（macOS 原生）：AX 取词失败应用清单（Teams/Pages/微信/图书…）证明 mac 上"强制取词"（模拟 Cmd+C）是必备开关；OCR 需屏幕录制权限。
- **STranslate**（Windows/WPF）：显式"替换原文"功能 + 译文前加"翻"字标记（可配置）防误替换。
- **CopyTranslator**：剪贴板监听 + PDF 复制断行清理（换行拼接重分段）——对"从 PDF 复制大量文本再翻译"场景价值很高。

### 各 OS 取词方案矩阵

**Windows**：
1. **UIA TextPattern**（首选）：`GetFocusedElement` → TextPattern → `GetSelection()` → `GetText(-1)`。无副作用、不碰剪贴板；Chromium/Edge/UWP 支持；旧 Win32 控件/游戏/自绘控件不支持。
2. **模拟 Ctrl+C + 剪贴板**（必备降级）：enigo 发键 → 等剪贴板序列号变化 → arboard 读取 → 还原。覆盖面最广；坑：终端里 Ctrl+C 是 SIGINT（SpeakNow 已有 `TERMINAL_CLASSES` 检测）、elevated 窗口被 UIPI 静默拦截（已有 `win_elevated()` 检测可提示）、剪贴板管理器会记录闪过的内容。
3. （可选后期）截图 OCR 兜底。

**macOS**：
1. **Accessibility API**（首选）：system-wide AXUIElement → `kAXFocusedUIElementAttribute` → `kAXSelectedTextAttribute`。需辅助功能权限 + 首启引导。
2. **模拟 Cmd+C**（"强制取词"开关）：需静音 beep、`NSPasteboard.changeCount()` 校验、剪贴板还原。

**触发面**：v1 用普通全局快捷键（`tauri-plugin-global-shortcut`，现有 `key_quick`/`key_translate` 同款模式）；Ctrl+C+C 双击检测需要 rdev 低级钩子 + 状态机，坑多（Ctrl 粘滞、与其他钩子应用互抢），放 v2/v3。

---

## 3. 集成设计（基于现有代码的落点）

### 3.1 新模块与改动清单

**`selection.rs`（新建，唯一从零写的核心模块）**
```
pub fn get_selection() -> SelectionResult
// SelectionResult { text: String, source: Uia | SimulatedCopy | Clipboard, anchor: Option<(x,y,w,h)> }
```
- Windows：`caret.rs::focused_anchor()` 已在 UIA STA 线程里拿 `TextPattern::GetSelection` 的 range（现只解析矩形，`parse_rect`）——对同一 range 调 `GetText(-1)` 即得选中文本，`windows` crate 的 `UI_Accessibility` feature 已启用，**零新依赖**。UIA 拿不到文本 → 降级模拟复制：复用 `inject.rs` 的 enigo 构造、`GetClipboardSequenceNumber` 校验、`SavedClipboard`（text+image）备份还原、`wait_modifiers_released`。终端前台时跳过模拟复制并提示。
- macOS：AX 取词 + `osascript` Cmd+C 降级（beep 静音 + changeCount 校验 + 还原）；首启权限引导（辅助功能）。`caret.rs` 目前 mac 是 stub，这块与取词定位一起补。

**`translate.rs`（新建，编排层）**
```
pub fn translate_selection(app)        // 热键入口：取词 → 建翻译会话 → 流式出结果
pub struct TranslateSession { gen, cancel, ... }   // 独立于听写 run_gen 的会话代
async fn run(cfg, text, app, superseded)  // llm::optimize_streaming(translate 模式快照)
```
- 翻译执行**完全复用** `llm.rs`：`mode="translate"` 的 system prompt（llm.rs:912）、翻译模式跳过 guard（llm.rs:747/793 已有先例）、thinking fast-path 覆盖 translate、流式 `sn-llm-delta` 事件、`TOKEN_FLOOR` 预算。
- 术语表复用 `glossary` + `apply_alias_fixes`。
- 写回：`inject::copy_only`（复制按钮）+ 替换原文 = 保存剪贴板 → set 译文 → `inject::paste_text`（整套 focus/修饰键/UIPI 检查已有）→ 延迟还原。替换选区 = 先向选区发送替换粘贴（选中状态下粘贴即覆盖，多数编辑器天然支持）。

**配置（`config.rs`）**
- `HotkeyConfig` 增加 `key_translate_selection: Option<String>`（`hotkey::apply` 注册第 4 个，`handle_event` 里 match——`key_quick`/`key_translate` 就是现成模板；HotkeyTab 的去重校验列表加一项）。
- 新增 `TranslateConfig` 节（或扩展 LlmConfig）：
  ```rust
  pub struct TranslateConfig {
      pub engine: String,          // "llm"（默认，复用 llm 通道）| "qwen_mt" | "deepl" | "local"
      pub target: String,          // 默认沿用 llm.translate_target
      pub auto_copy: bool,
      pub replace_marker: bool,    // STranslate 式"翻"字前缀，防误替换
      pub forced_copy: bool,       // macOS 强制取词（模拟 Cmd+C）
      pub blacklist: Vec<String>,  // 按应用禁用（DeepL 同款）
  }
  ```

**命令与事件**
- 新命令：`translate_text(text, target?)`（可复用/扩展 `optimize_text`，但其假定听写上下文的 bilingual 拼接需拆开）、`translate_selection`（手动触发）、`get_selection`（调试用）。
- 事件：`sn-translate { text, target, session }` 请求 → 复用 `sn-llm-delta` 流式 → `sn-translate-result { raw, final }`。注意 `events::emit` 会转发到外接显示屏（`display_api::publish`），翻译链事件**不应**发布到外部屏，需在 publish 映射里排除。

**前端**
- `Overlay.tsx` 加"翻译卡片"状态：源文 + 译文流式 + [复制] [替换原文] [钉住] 按钮，Esc/失焦隐藏（复用 `hide_later`/`overlay_pinned`）。定位复用 `caret::overlay_position`——选区 anchor 就是弹窗锚点，现有优先级链直接可用。
- 主窗口新增 `tabs/TranslateTab.tsx`：目标语、引擎选择、术语表（已有 UI 可搬）、触发方式、黑名单、本地模型包管理入口。`TabId` + NAV + lazy import 三处各加一行。
- v2 的"输入翻译"做成主窗口内工作台（DeepL 主窗形态）+ 长文档工作台（分块进度、双语对照）。

**本地翻译模型（可选包，v2）**
- 完全套用 `qwen_asr.rs` 模式：llama.cpp 官方预编译 runtime 下载（Job Object 防孤儿进程、健康检查、端口扫描）+ TranslateGemma-4B Q4 GGUF 按需下载（`sn-model-progress` 进度事件、`LocalModelStatus` 统一状态、`builtin_models`/`download_builtin`/`delete_builtin` 命令三件套直接扩展新 model id）。
- 端点是 OpenAI 兼容的 localhost，**现有 LLM 客户端零改动**，只要 provider 指向它。
- 翻译提示语处理注意：TranslateGemma 有自己的 prompt 模板（2K 上下文，逐段翻译管线天然适配）。

### 3.2 分期路线图

**v1 —— 划词翻译（最小可用，几乎全部复用现有设施）✅ 已实现**
> 代码：`src-tauri/src/selection.rs`（取词）、`src-tauri/src/translate.rs`（编排）、
> `Overlay.tsx` 翻译卡片、`tabs/TranslateTab.tsx`（设置 + 输入翻译工作台）。
> 命令：`translate_selection_cmd` / `translate_text` / `translate_retarget` / `translate_replace`。
1. ✅ `selection.rs`（Win：UIA GetText + 模拟复制降级 + 软换行合并；mac：强制取词路径）
2. ✅ `key_translate_sel` 热键 → `translate.rs` 编排 → overlay 翻译卡片（流式、双语、复制/替换、语言条切换、Esc 关闭、悬停钉住）
3. ✅ TranslateTab 设置页（目标语/第二目标语、术语表入口、黑名单、自动复制/替换标记/强制模拟复制）+ 输入翻译工作台
4. 未尽事项：macOS AX 取词（现为 Cmd+C 模拟复制单路径）、Ctrl+C+C 双击检测（v3）、截图 OCR 兜底（与 OCR 模块汇合后做）

**v2 —— 输入翻译 + 本地化（大部分已实现）**
> ✅ 主窗口输入翻译工作台（TranslateTab 内，流式双语）
> ✅ 剪贴板监听模式（复制即翻译，`translate.clipboardWatch`，默认关；自身写入不触发、黑名单生效、超长交给工作台）
> ✅ **本地翻译引擎**（`src-tauri/src/local_llm.rs`）：`translate.engine = local` 切换；默认 Qwen3-4B-Instruct-2507（非思考版，中文扎实）、Gemma-3-4B-it 可选，Q4 约 2.4~2.6GB 按需下载（镜像沿用语音识别页设置）；llama.cpp sidecar 与 Qwen3-ASR 共享 runtime 二进制但独立进程（端口 18320+ / server-llm.log / 孤儿清理互相避让 tracked_pid）；随应用预载、Vulkan 自动加速失败回退 CPU、超时放宽 300s
> ✅ qwen-mt-turbo 预设（已加入「AI 优化」预设列表）
> ✅ **结构化智能翻译**（`src-tauri/src/trans_struct.rs`）：JSON / YAML / properties·env 只译字符串值——位置扫描 + 原位回填（格式零漂移），占位符掩码保护（{name}/%s/{{var}}/$var/HTML 标签），非文本值（URL/路径/数字/布尔/locale）自动跳过，重复值去重，30 条一批编号协议 + 失配逐条兜底；`translate.structuredTranslate` 可关
1. TranslateGemma-4B 专属模型卡（等 llama.cpp 生态稳定后加入模型目录）

**v3 —— 大量翻译与进阶交互**
1. 长文档工作台：分块 + 滑动窗口上下文 + 术语检索注入 + 并发池 + TM（SQLite）+ 可选二遍审校
2. Ctrl+C+C 双击检测（rdev 钩子 + 状态机）
3. 截图 OCR 翻译（xcap + Windows.Media.OCR / Vision）
4. DeepL API / 火山 / 腾讯等专用引擎插件化（pot 模式，多引擎并排对比）
5. 文档导出（docx 段落级替换、EPUB 双语）

### 3.3 已知雷区（调研实证）

- **GPL 传染**：pot / pot-app/selection 均 GPL-3.0 且已归档——只借鉴算法思路，代码自写。
- **Windows elevated 窗口**：SendInput 被 UIPI 静默拦截；沿用现有 `win_elevated()` + 提示重启示例（注入已有同款处理）。
- **终端**：Ctrl+C 是 SIGINT；`TERMINAL_CLASSES` 前台检测 → 跳过模拟复制、提示改用 OCR（v3）或让用户手动复制。
- **macOS AX 失败应用**（Teams/Pages/微信等）：强制取词开关兜底；首启权限引导不可省。
- **剪贴板副作用**：所有模拟复制路径必须备份还原（`SavedClipboard` 已支持 text+image + 延迟还原 + 序列号守卫）。
- **Ctrl+C+C 已知冲突**：Brave 拦截、偶发唤出开始菜单——所以 v1 用普通快捷键，双击检测后置。
- **沉浸式翻译对 LLM 翻译三大痛点的结论**：术语不一致、领域跑偏、长文上下文丢失——解法（术语表/领域声明/滑动窗口）已排入设计，别省。

---

## 4. 参考资料（节选）

**评测与模型**
- WMT24 Findings: https://aclanthology.org/2024.wmt-1.75/ · WMT25 初步排名: https://arxiv.org/abs/2508.20550
- Qwen-MT: https://qwenlm.github.io/blog/qwen-mt/ · TranslateGemma: https://huggingface.co/google/translategemma-4b-it
- Alconost 引擎横评: https://alconost.com/blog/best-llm-for-translation
- 术语注入（ACL 2025）: https://aclanthology.org/2025.wmt-1.5/ · 滑动窗口上下文: https://aclanthology.org/2024.amta-1.16/

**交互与实现**
- DeepL 快捷键: https://support.deepl.com/hc/en-us/articles/4404976418706 · 应用黑名单: …/360020515439 · OCR: …/6258827
- pot-desktop: https://github.com/pot-app/pot-desktop · selection crate: https://github.com/pot-app/selection
- Easydict（AX 失败清单/强制取词）: https://github.com/tisfeng/Easydict/wiki/FAQ
- STranslate（替换原文）: https://github.com/STranslate/STranslate
- SendInput/UIPI: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

**定价**
- DeepL API: https://www.deepl.com/pro · DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
- 火山（200 万字/月免费）/ 腾讯（500 万/月免费）官方控制台页
