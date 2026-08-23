# DSH Browser Client — 端到端商用方案

> 让 LLM 通过浏览器浮窗会话，理解并操作用户当前正在浏览的任意页面
> （小红书、淘宝、内部系统、自研项目……），以用户已登录的真实浏览器会话为操作环境。

---

## 1. 产品定位

**一句话**：浏览器里悬浮的 DSH 智能助手 —— 它看得到你正在看的页面，听得懂你的自然语言指令，能替你操作页面、提取数据、完成跨页面的任务。

**核心差异化（vs Playwright MCP / browser-use 等工具）**：

| 维度 | 现有工具 | DSH Browser Client |
|---|---|---|
| 浏览器会话 | 另起无头浏览器（登录态要重搞） | **用户当前已登录的真实浏览器**，cookie/SSO/内网权限天然现成 |
| 执行主体 | 独立 agent | **DSH 完整 harness**：会话持久化、工具生态、技能、审批流、文件工作区 |
| 用户界面 | 独立窗口/CLI | **页面内浮窗**，边看边操作，天然贴合"帮我操作这个页面"的场景 |
| 上下文 | 冷启动 | 页面状态实时快照 + 跨轮累积笔记 |

**目标用户**：
- 普通用户：让 AI 帮自己操作小红书/淘宝/网页表单（提取数据、批量操作、自动填写）
- 开发/运营：让 AI 在已登录的后台/内网系统里执行操作、核对数据、抓取信息
- 开发者：让 AI 理解并操作自己开发的页面（配合本地源码目录）

---

## 2. 核心架构

```
┌─────────────────────── 浏览器 (Chrome/Edge) ───────────────────────┐
│                                                                     │
│  ┌─ 任意网页 ──────────────────────────────────────────────────┐    │
│  │  content script (MAIN world)                                  │    │
│  │   · page.snapshot: 结构化提取 DOM/可见文本/交互元素            │    │
│  │   · page.eval:     注入执行任意 JS（读 V8 堆里的数据）          │    │
│  │   · page.act:      点击/输入/滚动/键盘（真实事件）              │    │
│  │   · 网络监听:      hook fetch/XHR 捕获接口数据                 │    │
│  │        ▲                              │                        │    │
│  │        │ chrome.runtime.sendMessage   │                        │    │
│  └────────┼──────────────────────────────┼────────────────────────┘    │
│           │                              │                            │
│  ┌────────┴──────────────────────────────▼────────────────────────┐   │
│  │ background service worker (MV3)                                 │   │
│  │  · 常驻 WebSocket ↔ host（双向）                                 │   │
│  │  · 工具请求路由 → 对应 tab 的 content script                     │   │
│  │  · chrome.tabs.captureVisibleTab() 截图                          │   │
│  │  · URL→目录映射、配置管理                                         │   │
│  └────────▲──────────────────────────────┬────────────────────────┘   │
│           │        WebSocket (双向)      │                            │
│  ┌────────┴──────────────────────────────▼────────────────────────┐   │
│  │ 浮窗 panel (iframe, chrome-extension:// origin)                  │   │
│  │  · 会话聊天 UI（消息流/工具卡片/审批）                            │   │
│  │  · 当前页面状态条、工作区绑定                                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
        │  HTTP RPC (/ext-api/*) + WS 事件流 (/ext-events.mux)
        ▼
┌─────────────────────── DSH Host ───────────────────────────────┐
│  dsh-browser-host 插件 (lib/index.js)                            │
│   · /ext-api RPC 代理（已有）→ 复用 apiProxy 官方通道             │
│   · /ext-events.mux 事件流（已有）→ 会话事件推送                  │
│   · 双向通道升级（新）：扩展可上行回传工具结果                     │
│   · 页面工具注册（新）：                                        │
│       page.snapshot / page.eval / page.act / page.navigate      │
│       page.screenshot / page.network / page.wait                │
│   · 会话上下文注入（新）：prompt 自动附带当前页面快照摘要          │
│   · 页面笔记（新）：工作区内累积页面理解                          │
│   · 审批转发（新）：页面操作请求审批 → 浮窗 UI                    │
└───────────────────────────────────────────────────────────────┘
```

**数据流（一次页面操作）**：
1. LLM 调用 `page.act({ action: 'click', x, y })`
2. host 插件把请求经 WS 发给扩展 background
3. background 路由到当前 tab 的 content script
4. content script 在页面执行真实点击
5. 结果（成功/新 DOM 状态）逐层回传 → host 插件 → 工具返回 → LLM 上下文

---

## 3. 页面能力设计（工具集）

### 3.1 理解层 —— LLM 怎么"看"页面

| 工具 | 用途 | 返回 |
|---|---|---|
| `page.snapshot` | 当前页结构化视图 | URL、标题、可见文本摘要、交互元素清单（带定位坐标）、表单字段 |
| `page.screenshot` | 截图（视口/元素/整页） | 图片落盘到工作区 + 路径；多模态模型直接看 |
| `page.network` | 读取页面 fetch/XHR 活动 | URL/方法/状态/请求与响应体预览（MAIN-world hook 捕获） |
| `page.eval` | 执行任意 JS 读数据 | 页面内部状态、接口数据、任意 DOM 查询结果 |

**快照原则（不塞爆上下文）**：
- 默认返回**视口内**的可见文本 + 可交互元素清单（带稳定坐标），约 2-5K tokens
- 深层内容通过 `page.eval` 精确提取，按需取用
- 截图默认降采样（最大 1280px 宽），落盘工作区，模型按需读图

### 3.2 操作层 —— LLM 怎么"动"页面

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `page.act` | 点击/输入/滚动/悬停/键盘/清除 | `{ action, x?, y?, text?, key?, direction? }` |
| `page.navigate` | 跳转/后退/前进/刷新 | `{ action, url? }` |
| `page.wait` | 等待页面/元素/网络空闲 | `{ condition, timeout }` |
| `page.scroll` | 精确滚动到坐标/方向 | `{ x, y }` 或 `{ direction, amount }` |

**元素定位策略（针对小红书/淘宝这类混淆 DOM）**：
1. **坐标定位为主**：snapshot 返回元素坐标 → 点击坐标。对动态/混淆 class 最稳。
2. **selector 为辅**：对稳定元素（表单、按钮）用 CSS selector 精确定位。
3. **视觉闭环**：操作 → 截图 → 模型看结果 → 决定下一步。浏览器操作 agent 的黄金模式。

### 3.3 会话上下文 —— LLM 怎么"记住"页面

- **每次 prompt 自动注入**：当前页面 URL、标题、可见区域摘要（首次/页面变化时）
- **页面笔记**：工作区 `page-notes.md`，LLM 操作过程中持续记录页面结构理解、数据发现、任务进度；跨轮/跨会话累积
- **操作历史**：会话消息流天然保留操作轨迹（工具卡片）

---

## 4. 上行通道设计（核心工程）

现有 `lib/index.js` 的 WS 是 **downlink only**（host→扩展单向推事件，第 265 行 `websocket.on('message', () => websocket.close(1008, 'downlink only'))`）。升级为**双向**：

### 4.1 协议（JSON 帧，与现有事件帧同构）

```jsonc
// host → extension（下行，已有：会话事件）
{ "rpcId": "0", "payload": { "type": "session/event", ... } }

// extension → host（新增上行：工具执行结果 / 状态上报）
{ "kind": "tool-response", "requestId": "req-123", "ok": true, "result": { ... } }
{ "kind": "tool-error",  "requestId": "req-123", "error": { "code": "...", "message": "..." } }
{ "kind": "status",      "state": "connected", "tab": { "id": 7, "url": "...", "title": "..." } }
```

### 4.2 Host 侧工具执行（挂起-等待-回包）

```js
// lib/index.js 新增
const pendingTools = new Map()  // requestId -> { resolve, reject, timer }

// 工具注册（harness.defineTool，纯注册；execute 里挂起等待扩展回包）
harness.registerTool(ctx, {
  name: 'page.act',
  description: '在浏览器当前页面执行操作（点击/输入/滚动等）',
  parameters: { /* JSON Schema */ },
  output: { schema: { /* JSON Schema */ }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute: async (args, exec) => {
    const requestId = crypto.randomUUID()
    const result = await bridge.request(requestId, { tool: 'page.act', args }, exec.signal)
    return result
  }
})
```

**关键实现点**：
- `bridge.request()` 把请求写入 WS（若未连接则尝试拉起/报错），挂 pending map，等 `tool-response` 帧回包 resolve
- `exec.signal` 转发：用户取消/超时 → abort 扩展侧执行
- 超时默认 60s（页面操作可能较慢），可配置

### 4.3 扩展侧执行链路（MV3）

```
host 工具调用
  → WS 下行帧 { kind: 'tool-request', requestId, tool, args }
  → background service worker 收到
  → chrome.tabs.sendMessage(tabId, { type: 'dsh:tool', requestId, tool, args })
  → content script 执行（MAIN world 注入，真实页面上下文）
  → 结果 postMessage/回调 回 background
  → background WS 上行帧 { kind: 'tool-response', requestId, ok, result }
  → host pending resolve
```

**MV3 注意点**：
- background 是 service worker，**不能常驻** → 用 `chrome.runtime.connect()`（long-lived port）+ 心跳保活，或 WS 在面板 iframe 里维持（面板开着才有连接，符合产品形态：浮窗开着才能操作）
- **决策**：WS 由**面板 iframe**持有（面板 = 会话存在 = 连接存在），background 只做 tab 路由中转。这样生命周期自然对齐：关浮窗 → 断连 → host 工具报"扩展未连接"。

### 4.4 多标签页与目标选择

- 面板持有"当前操作 tab"概念：默认 = 用户当前激活 tab（content script 上报）
- `page.*` 工具默认作用于当前 tab；`page.act` 等可接受 `tabId` 参数（预留多 tab 编排）
- 面板 UI 显示当前操作页面 URL，用户可切换目标 tab

---

## 5. 安全性设计（商用必须）

| 威胁 | 防护 |
|---|---|
| 恶意网页通过 content script 窃取 DSH 会话 | content script 只通过 `chrome.runtime.sendMessage` 与 background 通信，**页面 JS 无法触达**；面板 iframe 是 chrome-extension:// origin，页面无法注入 |
| 扩展被恶意页面利用执行任意操作 | 所有 `page.*` 工具**默认需审批**（DSH approval 机制），用户可在浮窗点击批准/拒绝；高风险操作（eval、navigate 到新域）强制审批 |
| token 泄露 | token 随机 32 字节，权限 0600；仅本机回环地址通信；扩展不写日志 |
| LLM 越权操作 | 页面操作审批 + 操作日志（会话消息流完整记录） |
| XSS | panel 渲染使用 textContent / 转义；不用 innerHTML 渲染模型输出（参考现有 `esc()`） |

**审批流**：host 工具 `execute` 里调用 approval 服务（参考 DSH `interaction` 能力）→ 审批请求经 mux 事件推送到浮窗 → 面板显示审批卡片 → 用户批准/拒绝 → 结果回传工具执行。

---

## 6. 工程结构（最终形态）

```
dsh-browser-host/
├── lib/
│   ├── index.js              # 插件入口：路由/WS/通道（已有，升级双向）
│   ├── bridge.js             # 双向通道：请求挂起/回包路由
│   ├── tools/
│   │   ├── index.js          # 工具注册聚合
│   │   ├── snapshot.js       # page.snapshot
│   │   ├── eval.js           # page.eval
│   │   ├── act.js            # page.act / page.scroll
│   │   ├── navigate.js       # page.navigate / page.wait
│   │   ├── screenshot.js     # page.screenshot
│   │   └── network.js        # page.network
│   └── context.js            # 会话上下文注入 + 页面笔记
├── cordis.patch.yml          # 部署补丁（已有）
├── browser-ext/extension/
│   ├── manifest.json         # 权限升级：tabs, captureVisibleTab 等
│   ├── background/background.js  # tab 路由 + 截图 + 配置
│   ├── content/
│   │   ├── content.js        # 浮窗注入（已有）
│   │   ├── page-tools.js     # 页面执行核心（snapshot/eval/act）
│   │   └── content.css
│   ├── panel/                # 浮窗 UI（升级：官方风格消息流）
│   └── common/dsh-client.js  # wire client（升级：双向）
├── docs/
│   ├── BUSINESS_PLAN.md      # 本方案
│   └── USER_GUIDE.md         # 用户指南（安装/使用/配置）
└── test/                     # 测试环境（已有，扩展）
```

---

## 7. 实施路线（阶段划分）

### 阶段 1：地基 —— 双向通道 + 理解工具（✅ 已完成并验证）
- [x] WS 双向升级（上行回包通道）
- [x] host 注册 `page_*` 工具（snapshot / eval / act / navigate / wait / screenshot / network）
- [x] content script 执行核心（snapshot 提取 + MAIN world eval + 操作执行）
- [x] background tab 路由 + 截图
- [x] 端到端冒烟通过：LLM 调用 `page_snapshot` → 控制通道 → 扩展 → 回包 → LLM 正确回答页面内容

> **⚠ 已踩坑记录（重要）**：工具名**不能含 `.` 点号**（如 `page.snapshot`）——腾讯网关会以 `invalid_parameter_value` 拒绝含点工具名的整个请求体。改用下划线 `page_snapshot` 即通过。这是腾讯 intranet 网关（copilot.tencent.com/v2）的硬性约束；若部署到其他网关需再验证。

### 阶段 2：操作能力（✅ 工具已实现并验证）
- [x] `page.act`（点击/输入/滚动，坐标定位）
- [x] `page.navigate` / `page.wait`
- [x] `page.screenshot`（截图落盘 + 多模态）
- [x] `page.network` 网络监听（MAIN-world fetch/XHR 捕获）
- [ ] 操作审批流接入（危险操作需用户确认）

### 阶段 3：商用打磨
- [ ] 会话上下文注入（prompt 自动带页面快照摘要）
- [ ] 页面笔记机制（工作区累积理解）
- [ ] 浮窗 UI 升级（参考官方 ui-conversation 风格）
- [ ] 多 tab 编排、设置页完善、打包脚本（crx）
- [ ] 用户文档 + 演示（✅ 文档已齐：BUSINESS_PLAN / USER_GUIDE / README）

---

## 8. 验收标准

**功能**：
- [ ] 任意页面（含 SPA）浮窗可用：打开 → 连接 → 提问 → LLM 通过工具真实读取/操作页面
- [ ] 页面操作闭环：LLM 能在小红书/淘宝完成"读取当前页内容 → 按指令操作 → 确认结果"
- [ ] 会话持久：刷新页面/重开浮窗后会话与工作区仍在
- [ ] 审批生效：危险操作必须用户确认才执行

**工程**：
- [ ] host 插件在 DSH profile 中可插拔安装（cordis.patch.yml）
- [ ] 扩展在 Chrome/Edge MV3 下可加载运行（无报错）
- [ ] 双向通道无泄漏：断连/重连/超时/取消处理完备
- [ ] 冒烟测试通过（test/env 现有环境扩展）

**安全**：
- [ ] 页面无法触达 DSH 会话数据
- [ ] token 不出本机、不落日志
- [ ] 所有危险操作有审批

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| MV3 service worker 生命周期导致连接不稳 | WS 由面板持有，生命周期对齐；background 仅中转，无状态 |
| SPA 页面 DOM 动态变化导致坐标失效 | 操作后自动重截图/重快照验证；坐标+selector 双策略 |
| 大页面快照超时 | 快照限制视口 + 元素上限；深层内容 eval 按需取 |
| 截图依赖多模态模型 | 截图落盘工作区，模型无关；用户可配置视觉模型 |
| DSH API 版本差（本地 rc.8 vs 源码 rc.11） | 用 Inspect Provider 实测为准；工具注册走 harness 标准 API |

---

*本文档与实现代码同步演进；实现细节以代码注释与 README 为准。*
