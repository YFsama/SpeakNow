# OCR 技术调研与实现方案（2026-09-25）

> 需求：为 SpeakNow 增加「大量 OCR」能力——截图即时取词（延迟敏感）+ 批量图片识别（吞吐敏感），中英混合为主，**本地优先**，体验优先。
> 结论先行：**分层引擎架构**——本地快路径（Windows 系统引擎，已实现）→ 本地质量档（PP-OCRv5 ONNX，规划）→ 本地高精度档（PaddleOCR-VL + llama.cpp，规划）→ 云端兜底（GLM-OCR API，规划）。
> M1（截图取词全链路）已落地，见文末实现说明。

---

## 一、格局速览（2026 三个关键事实）

1. **1B 专用 OCR 小模型已经反超云端旗舰**。OmniDocBench v1.6 端到端榜：TeleOCR(1.2B) 96.91、OvisOCR2(0.8B) 96.47、PaddleOCR-VL-1.6(0.9B) 96.34、GLM-OCR(0.9B) 95.22，而 Gemini 3 Pro 92.91、Qwen3-VL-235B 仅 89.78。**通用大 VLM 做文档解析打不过 1B 专用模型**，本地高精度档不再需要"云级别"的模型体积。
2. **PaddleOCR 轻量管线依然是毫秒级取词之王**。PP-OCRv5/v6 mobile 全套（det+cls+rec）约 22MB，CPU 单张约 0.2-1s，印刷体中文准确率 86%（server 档 90%），Apache-2.0。Umi-OCR（47.5k star）在桌面端验证了这一组合。
3. **云端 OCR 的价格被大模型打崩了**。智谱 GLM-OCR API 单张约 0.0002-0.0005 元（官方锚点 1 元≈2000 张 A4），GLM-4.6V-Flash 免费；传统云 OCR（腾讯 0.15 元/次）贵 100 倍以上，已无选型意义，仅剩"坐标+置信度结构化输出"场景。

## 二、候选方案对比

### 本地轻量引擎（截图取词档）

| 引擎 | 中文 | 单张 CPU | 体积 | Rust/Tauri 集成 | 许可 | 结论 |
|---|---|---|---|---|---|---|
| **PP-OCRv5/v6 mobile (ONNX)** | 印刷体 86-90% | 0.2-1s | 约 22MB | `ort` crate 直载（det/cls/rec 三模型） | Apache-2.0 | **质量档首选（M2）** |
| RapidOCR | 同上（同款模型） | 约 200ms | 同上 | 官方无 Rust，可直载其 ONNX + 自写前后处理（`paddle-ocr-rs` crate 有完整参考实现） | Apache-2.0 | 同上（模型来源） |
| **Windows.Media.Ocr** | 中下（依赖语言包） | <0.2s | 0 | `windows` crate 直调，词级坐标 | 系统 API | **快路径首选（M1，已实现）** |
| Tesseract 5.5 | 差（中英混排约 75%） | 1s+ 且需预处理 | 30-50MB/语言 | C 绑定 | Apache-2.0 | 淘汰：中文代差 |
| ocrs（纯 Rust） | **无中文** | 快 | 小 | 原生 | Apache-2.0/MIT | 淘汰：无 CJK |
| Surya 2 (0.65B) | 82.5% | CPU 慢约 50 倍 | 大 | 无 | **权重商用受限** | 淘汰 |
| EasyOCR | 中下 | 慢 | 约 100MB | 无 | Apache-2.0 | 淘汰：停更两年 |

### 本地 VLM（高精度档，M4）

| 模型 | 参数 | OmniDocBench | 体积(GGUF) | llama.cpp | 许可 | 结论 |
|---|---|---|---|---|---|---|
| **PaddleOCR-VL-1.5/1.6** | 0.9B | 94.93 / 96.34 | 官方 GGUF 共 **0.87GB**（Q4 社区版 0.38GB） | 官方支持，`llama-server -hf` 一键拉起，Windows Vulkan 已验证 | Apache-2.0 | **首选**：中文最强 + 与现有 Qwen3-ASR sidecar 完全同构 |
| GLM-OCR | 0.9B | 95.22（v1.5） | ggml-org 收录 | 官方支持 | CC BY 4.0（需署名） | 备选：速度最快（0.67 pages/s，约为 Paddle 1.7 倍），多语言强 |
| HunyuanOCR | 0.5B | OCRBench 860（官方） | Q8 578MB+mmproj | 官方支持 | 腾讯社区许可（商用需审） | 最小档备选 |
| dots.ocr | 3B | 90.77 | — | 支持 | MIT | 偏慢（0.10 pages/s） |
| olmOCR 2 | 7B | 85.74 | 无 GGUF | 不支持 | Apache-2.0 | 淘汰：中文弱、无 GGUF |
| TeleOCR / OvisOCR2 | 1.2B / 0.8B | 96.91 / 96.47 | 待发布 | 未见 | 待确认 | 关注：榜单前二，等 GGUF |

**硬件门槛**：4GB 显存即可跑 0.9B 档（llama.cpp 维护者结论），8GB+ 舒适（PaddleOCR-VL vLLM 实测约 2.6s/页）；纯 CPU 0.9B 约 10-30s/页，可作降级兜底。VLM 档优势场景：复杂版面/表格/公式/手写/低质截图（Real5 85.54）；劣势：比传统管线慢 2-3 个数量级、有幻觉（`--temp 0`）、**无坐标**（截图取词必须传统 OCR）。

### 云端（兜底/免费档）

| 方案 | 单张成本 | 1 万张 | 10 万张 | 备注 |
|---|---|---|---|---|
| **智谱 GLM-OCR** | ≈0.0002-0.0005 元 | 2~5 元 | 20~50 元 | **与现有智谱凭据组零新增接入**，layout_parsing 接口 |
| 智谱 GLM-4.6V-Flash | **免费** | 0 | 0 | 免费兜底档 |
| 阿里 qwen-vl-ocr（Batch 半价） | ≈0.0004（0.0002） | 4 元（2 元） | 40 元（20 元） | 批量首选，min/max_pixels 可控成本 |
| 百度/腾讯传统 OCR | 0.005-0.15 元/次 | 50-1500 元 | 250-15000 元 | 淘汰：贵 10-300 倍 |
| OpenAI / Gemini | — | — | — | 大陆不可达 + 数据出境合规风险，默认关闭 |

隐私：截图是敏感数据重灾区（聊天记录/密码框/合同），**默认本地处理、上云须用户显式开启**是产品红线。

## 三、SpeakNow 分层架构（结论）

```
┌─ 快路径（默认，0 体积 0 下载）—【M1 已实现】──────────────┐
│ Windows.Media.Ocr：热键→每屏透明框选窗→GDI 物理像素重截     │
│ →系统引擎识别（毫秒级）→悬浮窗 OCR 卡片（复制/翻译/输入）    │
├─ 质量档（约 22MB，HF 一键下载）—【M2 规划】────────────────┤
│ ort crate + PP-OCRv5/v6 mobile 三模型；paddle-ocr-rs 参考   │
│ 前后处理；DirectML 可选，CPU 兜底；中文主力档+批量档         │
├─ 高精度档（0.87GB GGUF）—【M4 规划】──────────────────────┤
│ llama-server --mmproj 跑 PaddleOCR-VL：现有 sidecar 设施    │
│ （进程管理/Vulkan-CPU 切换/HF 下载）80% 复用；复杂版面/表格  │
├─ 云端兜底（复用凭据组）—【M4 规划】────────────────────────┤
│ 智谱 GLM-OCR（疑难图重识别）/ GLM-4.6V-Flash（免费档）       │
└────────────────────────────────────────────────────────────┘
```

**M1 实现说明**（已落地）：
- `src-tauri/src/ocr.rs`：GDI 截屏（BitBlt+CAPTUREBLT，HALFTONE 缩放超限区域）+ Windows.Media.Ocr（MTA ComGuard + IMemoryBufferByteAccess 零拷贝写入 + CJK 空格清洗）+ 选区窗编排（每屏一窗、首次创建后隐藏复用、防重入）
- 前端：`OcrSelect.tsx`（框选层，pointer capture、Esc/右键/单击取消、尺寸角标）+ Overlay OCR 卡片（自适应高度、复制/翻译/输入/再截一次）+ OcrTab 设置页（语言包检测与安装引导）+ 热键页 keyOcr
- 翻译链完全复用：OCR 卡片「翻译」→ `translate_announce` → 现有流式翻译卡片；`ocr.autoTranslate` 开启即截图翻译一键链
- 选区坐标链路：前端逻辑像素 × 窗口 scale + 窗口物理原点 → GDI 物理矩形，确认瞬间重截，所见即所识别

**M2-M4 待办**：ort+PP-OCRv5 质量档（含批量队列 UI：任务列表/进度/导出 txt·md·jsonl）、PaddleOCR-VL sidecar（mmproj 双文件下载管理）、云端 GLM-OCR 接入（触发策略：本地置信度低/表格公式图直上云、隐私模式全局禁云）。

## 四、主要来源

OmniDocBench（opendatalab）· PaddleOCR 官方文档与 model_list · PaddleOCR-VL-1.5-GGUF（HuggingFace）· GLM-OCR 论文（arXiv 2603.10910）· llama.cpp multimodal 文档与 PR #18825 · ngxson《Using OCR models with llama.cpp》 · ort.pyke.io · paddle-ocr-rs（mg-chao）· Umi-OCR · pot-desktop · 智谱/阿里云/百度/腾讯官方定价页 · OpenAI/Google 官方定价与地区列表。完整链接见各分报告（本次调研四路并行：本地轻量引擎 / 本地 VLM / 云端成本 / 集成体验）。
