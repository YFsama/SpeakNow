# 记忆库（Mem）

> 把「说过、看过、译过」的产出自动沉淀为可检索的个人记忆——受
> [Nowledge Mem](https://mem.nowledge.co) 的「记忆层」理念启发，为 SpeakNow
> 的语音输入工作流补上「记」的一环：输入进来，记忆留下。

## 为什么做

SpeakNow 的听写 / 截图取词 / 划词翻译产出此前只进了 `history.json`
（默认保留 50 条、按窗口滚动删除），本质是「最近使用」而非「知识」：

- 找不到三天前口述的某段结论（早被滚动清掉）；
- 没有关键词维度，只能靠肉眼翻；
- 译文/OCR 结果散落，无统一检索面。

调研 Nowledge Mem（本机安装 v0.10.103，Tauri 2 同栈）后确认的可行路径：
**采集自动化 → 蒸馏增强 → 混合检索**。它的完整形态（知识图谱、社区
发现、MCP 服务、agent 蒸馏调度器）过重，SpeakNow 取其最小内核并保持
零新增依赖、纯本地、JSON 存储。

## 数据流

```
听写终稿(pipeline) ─┐
OCR 文本(ocr)      ─┼→ mem::capture() → 查重 → mem.json → (可选)LLM 蒸馏
翻译译文(translate)─┘        │                        │
                             │ sn-mem-changed          │ title/keywords 回填
                             ▼                         ▼
                   设置页「记忆」时间轴 + 加权检索   （再广播一次）
```

- 采集在会话线程做廉价判断（开关 + 查重），写盘与蒸馏全部后台线程，
  绝不阻塞热键/主线程路径。
- 去重：与最新一条 `(kind, app, text)` 完全相同则跳过（OCR/翻译的重复
  触发不会灌库）。
- 滚动清理：超过 `mem.limit`（默认 500）从最旧删起，置顶不占名额
  （上限 20，与历史页同口径）。

## 检索语义（前后端 + mock 三方一致）

查询按空白分词，词间 AND；每个词小写化后对每条记忆打分：

| 命中位置 | 分 |
|---|---|
| keywords 任一包含 | 3 |
| title 包含 | 2 |
| text 包含 | 1 |

- 无查询：置顶优先，再按时间倒序；
- 有查询：按总分降序，同分按时间倒序；
- kind 过滤（dictation / ocr / translate）在打分前淘汰；
- 参考实现：`src-tauri/src/mem.rs` 与 `src/dev/mock-tauri.ts` 的
  `mockMemSearch` 保持逐字对齐（浏览器 mock 模式行为一致）。

## AI 蒸馏

`mem.distill` 开启且「AI 优化」已配置 LLM 时，入库先落盘
（title=正文前 40 字），随后后台线程调 LLM 提炼
`{"title": 一句话标题, "keywords": [≤6 个关键词]}`，成功后按时间戳回填
并再广播一次。任何失败（未配置 / 超时 10s / JSON 解析失败）静默降级，
记忆本身照常可检索——蒸馏是增强，不是依赖。

## 契约

配置（`config.rs MemConfig` ↔ `types.ts MemConfig`，camelCase）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关：关闭停采，既有记忆仍可检索 |
| `captureDictation` / `captureOcr` / `captureTranslate` | true | 三个采集来源 |
| `distill` | false | LLM 蒸馏关键词与标题 |
| `limit` | 500 | 保留条数（滚动清理） |

命令（`lib.rs` ↔ `api.ts`，CI 契约对账覆盖）：

| 命令 | 说明 |
|---|---|
| `mem_list(query, kind, limit)` | 检索 + 概览统计（统计不受过滤影响） |
| `mem_delete_batch(ts[])` | 批量删除，返回实际删除数 |
| `mem_set_pinned(ts, pinned)` | 置顶 / 取消置顶 |
| `mem_clear()` | 清空（含置顶） |

事件：`sn-mem-changed`（采集 / 删除 / 置顶 / 清空 / 蒸馏回填后广播）。

存储：`mem.json`（应用配置目录，与 `history.json` 同层同模式——全局
Mutex + 后台写盘 + 事件广播）。

## 与 Nowledge Mem 的关系

本项目读取 Nowledge Mem 的调研结论见其本地安装分析（本机 v0.10.103：
REST `127.0.0.1:14242`、SQLite 知识图谱、LanceDB 向量索引、agent 蒸馏
调度器）。SpeakNow **不读取、不依赖**其数据；受其启发实现的差异：

| 维度 | Nowledge Mem | SpeakNow Mem |
|---|---|---|
| 采集面 | 50+ AI 工具会话、文件、URL | 本应用听写 / OCR / 翻译产出 |
| 索引 | 1024 维向量 + BM25 混合 | 关键词加权检索（零依赖） |
| 增强 | 知识图谱 + 社区发现 + 夜间任务 | 单条 LLM 蒸馏（可选） |
| 对外 | REST / MCP / CLI / FS | 设置页检索（后续可挂 display_api 出 REST） |

设计取舍：不引入 SQLite / 向量库 / embedding 模型——记忆量级（≤1 万条）
下加权检索已够用，换来的是零依赖、零下载、可随时手改 JSON 的透明度。

## v2：召回与反馈闭环（借鉴开源记忆层）

v2 的每个机制都有开源出处，且刻意选择了参考项目没做或做不到位的能力：

| 机制 | 出处 | 说明 |
|---|---|---|
| 多因子检索 | Generative Agents（0.995^小时衰减）+ Elasticsearch（`1+log10(1+use_count)`） | `score = 文本分 × 0.95^天数 × (1+log10(1+uses))`；空查询 = 置顶 + 「用过/采过」最新浮顶 |
| 使用反馈闭环 | GA「检索即保鲜」；mem0/Letta 均未做（差异化） | **仅实际注入/复制才计数**（`uses`/`lastUsedAt`），检索命中不算——防错误记忆自我强化 |
| 近重复合并 | mem0 去重决策的简化 | 同 kind+app 且字符 bigram Jaccard ≥ 0.75 → 不另立条目，`hits` 累计 |
| 采集黑名单 | 隐私优先自创 | 内置密码管理器名单（1Password/KeePass/Bitwarden 等）**始终生效不可关**；`captureBlacklist` 用户可扩充 |
| 记忆召回热键 | Raycast/Alfred/PowerToys/Win+V 公约数 + Nowledge IME 教训 | `keyMemRecall`（建议 Alt+M）呼出悬浮搜索卡：空查询=最近、输入即搜（120ms 防抖）、↑↓ 选择、Enter 注入当前输入框、Ctrl+Enter 仅复制、Esc 关闭；**IME 组态期不响应按键**（Nowledge 连修四版的坑） |
| 对外 REST | Nowledge Context Bundle / working-memory 实测格式简化 | display_api 挂 `GET /mem/search?q=&k=`（JSON）与 `GET /mem/context.md`（工作记忆 markdown，置顶全文 + 最近 20 条 + 免责句，4KB 字符预算）——任何本机 AI 工具可读 SpeakNow 记忆 |

v2 命令：`mem_recall`（多因子检索，空查询最近序）/ `mem_used`（计一次实际
使用）/ `mem_recall_paste`（注入当前输入框并计使用）/ `mem_copy_used`
（复制并计使用）。事件新增 `sn-mem-recall`（携带最近条目打开悬浮卡）。
`mem_list` 保持 v1 语义不变（设置页浏览场景，与 mock 对账稳定）。

明确的路线图外（本期不做）：LLM 冲突裁决（mem0 的 ADD/UPDATE/DELETE 决策）、
向量/BM25 索引、bi-temporal 四时间戳、夜间蒸馏调度、MCP 服务。
REST 暂不做 token 鉴权（默认 loopback-only，LAN 暴露沿用 display_api 的
allowLan 开关口径）——若要暴露给局域网请自行评估。

## v3：导入中心 / 存储管理 / 安全（借鉴 RAG 分块与 mem0 裁决）

### 导入中心（设置页「记忆 → 导入与快记」）

| 来源 | kind | 说明 |
|---|---|---|
| 快速记一条 / 剪贴板 | `note` | 便签级内容整条入库 |
| 网页 URL | `web` | 后端抓取（协议白名单 http/https、5MB 流式截断、15s 超时、Content-Type 校验、禁自动重定向手动跟跳 ≤3）→ Readability 抽正文（dom_smoothie）→ 编码探测（BOM > HTTP > meta，chardetng 兜底）；正文过短用 meta description 兜底并标「低置信」 |
| 文本文件（.txt/.md 多选） | `file` | 10MB 截断；UTF-8 与 NUL 字节校验拒二进制伪装 |
| 项目文档（选目录） | `file` | 递归 .md/.txt（跳 node_modules/.git/target 等，上限 200 个）；每个文件 canonicalize 断言仍在根目录内（防 junction 越界） |

分块策略（RAG 实践，适配无向量的子串检索）：≤800 码点整条；超过则按
markdown 标题 > 空行段落 > 句末标点递归切成 400~600 码点块（硬上限 800），
块标题 =「来源标题 > 标题链」面包屑（title 是 2 分权重位，面包屑免费加权）；
**重叠为零**——子串场景重叠只会污染 hits 统计。

显式导入/快记**不走采集黑名单**（黑名单只管自动采集；用户主动行为），
但同样走近重复合并。URL 导入不做内网 IP 拦截：URL 由用户在设置页亲自
输入，与浏览器同信任级，且 REST 端点不暴露导入命令。

### 存储管理

- 写盘沿用 `config::atomic_write`（tmp → bak → rename），`mem.bak` 自动存在
- 软作废条目（下述）保留策略 = Obsidian 模式：留在库里、检索/召回/context
  一律过滤、设置页可见（「已被取代」徽章）、导出保留；与普通条目同规则
  参与滚动清理
- 存储卡（记忆页）：条数（置顶/已作废）· mem.json 与 mem.bak 字节数 · 累计字数

### LLM 冲突裁决（mem0-lite，`mem.distill` 开启时）

蒸馏调用附带 OR 召回的前 10 条候选（`ts + 相对时间 + title + 正文前 200 码点`），
模型可返回 `supersedes`（语义明确矛盾/完全重复时）。三道闸防幻觉：
JSON 解析失败重试一次后整体 NOOP；`supersedes` 必须在候选集内（代码层校验，
不靠提示词）；不确定一律 NOOP（错误合并不可逆，重复入库已被 hits 兜住）。
命中则旧条 `supersededBy = 新条 ts`（软作废，Graphiti 的「作废优先于删除」）。

### REST 令牌（安全）

- `/mem/*`：**loopback 免钥**（本机 AI 工具零配置）；非 loopback（即开启
  局域网后）必须携带 `X-SN-API-Key`，与 `mem.apiToken` 常时比较（防时序
  侧信道）相等才放行，否则 401
- 令牌为空 = 未授权远程（fail-closed）；设置页「外接显示」可生成/轮换，
  轮换立即生效（每请求读配置）
- 与 LLM Key 同存 config.json（本机明文，与既有凭据口径一致）

### 尚未做（更新后的路线图）

向量/BM25 索引、bi-temporal 四时间轴、夜间蒸馏调度、MCP 服务、r.jina.ai
云抽取增强开关（默认关闭，隐私代价：URL 过第三方服务器）、mem.bak 按天
轮换多份。单文件逼近 10MB 时再考虑 append-only JSONL + 快照 compaction
两文件制（当前量级原子写 + bak 已是业界正确答案）。
