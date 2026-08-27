# SpeakNow 外接显示 API（硬件字幕屏）

> 面向场景：客户有外接硬件（平板、树莓派 + 屏幕、副屏电脑、自研显示设备），希望**本地不弹聆听窗口，字幕只在外接硬件上显示**。

SpeakNow 内置一个轻量 HTTP + WebSocket 服务，把「聆听窗口」的全部字幕事件实时推送出去。**不需要写一行代码**即可使用内置显示页；自研硬件则按本文协议接入。

在设置 → **📡 外接显示** 中开启「启用外接显示 API」即可（默认端口 `8866`，默认仅本机可连；勾选「允许局域网设备连接」后，同一网络内的硬件均可访问）。

---

## 1. 零代码：内置远程显示页

在外接硬件的浏览器打开：

```
http://<SpeakNow 所在机器 IP>:8866/display        # 局域网（需开启 allowLan）
http://127.0.0.1:8866/display                     # 本机调试
http://<ip>:8866/display?scale=1.5                # 整体放大字号，适配小屏
```

页面实时呈现：阶段状态（聆听/识别/AI 优化/完成/出错）、录音电平波形、流式字幕、AI 逐字输出、终稿与原文对照、耗时。断线自动重连。

要**本地不再弹出悬浮窗**：同一页勾选「外接显示时隐藏本地悬浮窗」。

## 2. HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /display` | 内置远程显示页（同 `/`） |
| `GET /api/status` | 服务信息（JSON），可用于健康检查 |
| `GET /api/events` | WebSocket 事件流（见下） |

`GET /api/status` 返回示例：

```json
{
  "app": "SpeakNow",
  "version": "0.4.5",
  "protocol": 1,
  "events": "/api/events"
}
```

## 3. WebSocket 事件协议（预留 API）

连接 `ws://<ip>:<port>/api/events`。每条消息是一个 **版本化信封**：

```json
{
  "v": 1,              // 协议版本（信封结构不兼容变更时 +1）
  "type": "result",    // 事件类型，见下表
  "data": { ... },     // 事件数据
  "ts": 1724650000000  // 服务端毫秒时间戳
}
```

**兼容性约定（对客户端的要求）**：

1. 忽略**未知 `type`**——未来版本会新增事件类型；
2. 忽略 `data` 中的**未知字段**——现有事件只增字段不改语义；
3. 连接建立后服务端先发一条 `hello`，客户端可据此展示版本信息。

### 事件类型

| type | 触发时机 | data 字段 |
|---|---|---|
| `hello` | 连接建立后首条 | `app`、`version`、`protocol` |
| `status` | 阶段变化 | `stage`: `idle` / `recording` / `transcribing` / `optimizing` / `review` / `done` / `error`；`message`: 提示文案；`sound`: 是否播放提示音 |
| `level` | 录音期间每 100ms | 录音电平数值（0~1，裸数字） |
| `meta` | 每次识别开始 | `asrModel`、`llmEnabled`、`llmModel`、`skip`（本次是否跳过 AI） |
| `partial` | 流式分段识别出一段（边说边出字） | `text`: 已识别字幕累计 |
| `raw` | 完整原始转写出炉（AI 优化期间即可阅读） | `text` |
| `delta` | AI 优化逐字流式输出 | `kind`: `content` / `reasoning`（思考过程）；`delta`: 本段增量；`text`: content 时为累计全文 |
| `result` | 最终结果确认 | `raw`、`final`、`asrMs`、`llmMs`、`llmFirstMs`、`audioSecs` |
| `target` | 悬浮窗定位到目标输入框时（仅本地悬浮窗开启时会有） | `title`: 目标窗口标题；`above` |

一次典型会话的事件顺序：

```
hello → status(recording) → level×N → partial×N → status(transcribing)
→ raw → status(optimizing) → delta×N → result → status(done) → status(idle)
```

## 4. 接入示例

### 浏览器 / Node.js

```js
const ws = new WebSocket('ws://192.168.1.10:8866/api/events');
ws.onmessage = (e) => {
  const { v, type, data, ts } = JSON.parse(e.data);
  if (v !== 1) return;                 // 版本检查
  if (type === 'result') console.log('终稿：', data.final);
  if (type === 'delta' && data.kind === 'content') render(data.text);
  // 未知 type 直接忽略
};
```

### Python

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect('ws://192.168.1.10:8866/api/events') as ws:
        async for raw in ws:
            m = json.loads(raw)
            if m['type'] == 'result':
                print('终稿:', m['data']['final'])

asyncio.run(main())
```

### 嵌入式硬件（ESP32 等）

固件需支持 WebSocket 客户端即可。只关心终稿时，可忽略 `level` 等高频事件，仅处理 `type == "result"`，按 `data.final` 渲染。`level` 事件约 10 条/秒，算力紧张可跳过。

## 5. 安全与部署说明

- 默认监听 `127.0.0.1`（仅本机）；「允许局域网设备连接」后监听 `0.0.0.0`，首次 Windows 会弹防火墙授权，请勾选**专用网络**（公共网络环境不建议开放）
- 服务**无鉴权**，只读单向推送字幕事件，不能触发录音、不能读取配置与 Key；公共/不可信网络请勿开启局域网访问
- API 属于预留能力：后续计划增加硬件端确认/重试指令上行、多端会话管理等，均以新 `type` 或新端点形式扩展，不影响现有客户端
