# DSH Browser Client

让 LLM 通过浏览器浮窗会话，理解并操作用户当前浏览的任意页面。

**核心能力**：在任意网页右下角浮窗中运行 DSH 会话 —— LLM 通过 `page_*` 工具读取页面快照、执行 JS、点击/输入/滚动、截图，操作的是**用户已登录的真实浏览器**（cookie/SSO/内网权限天然现成）。

```
┌─ 浏览器 ──────────────────────────────────────────────┐
│ content script（页面内执行 snapshot/eval/act）           │
│   ↕ chrome.runtime.sendMessage                         │
│ 面板 iframe（聊天 UI + 双向 control WebSocket）          │
│   ↕ HTTP RPC (/ext-api) + WS (/ext-api-control)        │
├─ DSH Host ─────────────────────────────────────────────┤
│ dsh-browser-host 插件                                  │
│  · /ext-api RPC 代理（复用官方 apiProxy 通道）           │
│  · /ext-events.mux 事件流                               │
│  · /ext-api-control 双向通道（工具请求↔回包）             │
│  · page_* 工具注册（harness → tools.register）           │
└───────────────────────────────────────────────────────┘
```

## 结构

```
lib/
  index.js      # 插件入口：路由/WS/工具注册
  bridge.js     # 双向通道：工具请求挂起/回包路由/超时/断连
  tools.js      # 6 个 page_* 工具定义（中继到扩展执行）
browser-ext/extension/
  manifest.json # MV3 扩展（storage/activeTab/scripting/tabs）
  content/content.js     # 浮窗气泡 + Shadow DOM 面板注入
  content/page-tools.js  # 页面执行核心（snapshot/eval/act/...）
  background/background.js # 配置 + URL→目录映射 + 截图
  panel/                  # 浮窗聊天 UI
  common/dsh-client.js    # 双向 wire client
docs/
  BUSINESS_PLAN.md  # 完整商用方案
  USER_GUIDE.md     # 安装/使用/故障排查
test/
  bridge-unit-test.mjs    # 通道生命周期单测（通过）
  e2e-page-tool.mjs       # 全链路 E2E（LLM→工具→通道→扩展→回包→回答）
```

## 页面工具

| 工具 | 作用 |
|---|---|
| `page_snapshot` | 页面结构化快照（URL/标题/可见文本/交互元素+坐标） |
| `page_eval` | 页面 MAIN world 执行任意 JS 读数据 |
| `page_act` | 点击/输入/滚动/键盘/清除（坐标或选择器） |
| `page_navigate` | 跳转/后退/前进/刷新 |
| `page_wait` | 等待选择器/网络空闲/延时 |
| `page_screenshot` | 截图（视口/元素/整页） |
| `page_network` | 读取页面 fetch/XHR 请求（URL/方法/状态/响应体预览） |

> ⚠ **工具名用下划线不用点号**（`page_snapshot` 而非 `page.snapshot`）：腾讯 intranet 网关拒绝含点号的工具名。详见 `docs/BUSINESS_PLAN.md` 的踩坑记录。

## 快速开始

1. **Host 插件**：把 `cordis.patch.yml` 插入 DSH profile，重启 DSH。启动日志打印 token 并注册 6 个工具。
2. **扩展**：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `browser-ext/extension`。
3. **配置**：面板 ⚙ 填 Host 地址 + token（`$DSH_HOME/browser-client-token`）。
4. **使用**：浮窗里问"这个页面现在显示什么？" → LLM 调 `page_snapshot` 回答。

详见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 测试

```bash
# 1. 通道单元测试（不需要 DSH 进程）
node test/bridge-unit-test.mjs

# 2. 全链路 E2E（需要：DSH 测试实例 + LLM key）
#    boot test/env 实例 + 模拟扩展回包，验证 LLM→工具→通道→页面→回答
node test/e2e-page-tool.mjs
node test/e2e-page-network.mjs

# 3. 真实浏览器 E2E（需要：360Chrome 加载扩展 + DSH 实例）
#    真实面板 + 真实 content script 执行 page_snapshot，LLM 读取真实页面数据
node test/live-e2e-real.mjs
```

## 实机验证记录

在 360Chrome（Chromium 132）加载扩展 + DSH host（:3999）实测通过：

- 页面右下角浮窗注入（Shadow DOM）✅
- 面板连接 host、绑定工作区、加载会话列表 ✅
- **真实链路**：面板提问 → LLM 调用 `page_snapshot` → 控制通道 → 面板 → content script → 读取真实页面 DOM（"机械键盘 ¥299 / 降噪耳机 ¥899 / 4K 显示器 ¥1999"）→ 回传 → LLM 完整作答 ✅

> ⚠ Chrome 151+ 在 macOS 上禁用了 `--load-extension` 命令行加载；实测 360Chrome 支持。Chrome 用户需通过 chrome://extensions 开发者模式手动加载。

## 状态

- ✅ 阶段 1（双向通道 + 6 个 page_* 工具 + E2E 验证）**完成**
- 🔜 阶段 2（操作审批流、页面笔记、多 tab 编排）
- 🔜 阶段 3（浮窗 UI 升级、打包 crx、视觉闭环打磨）

详见 [docs/BUSINESS_PLAN.md](docs/BUSINESS_PLAN.md)。

## 验证规范（重要）

**绝不启停 3080 生产实例**。所有验证通过独立新端口实例进行：

```bash
# 启动隔离实例（默认 4101，可指定任意端口）
./test/verify-boot.sh 4101
# 停止
./test/verify-boot.sh 4101 stop

# 指向该实例跑测试（token 是 per-port 的）
DSH_BASE=http://127.0.0.1:4101 TOKEN_FILE=test/env/browser-client-token-4101 \
  node test/workflow-store-test.mjs
```

- 每个端口实例有独立 token 文件（`browser-client-token-<port>`）和日志（`boot-<port>.log`）
- 存储后端共享 `$DSH_HOME`，天然验证跨实例持久化

## 网页工作流功能（面向非研发人员）

用户用对话描述重复性网页工作 → LLM 生成可保存/重跑的工作流 → 自动执行。

### 能力一览

| 能力 | 说明 |
|---|---|
| `workflow_generate` 工具 | LLM 把对话需求转化为结构化工作流并保存 |
| `page_record` / `page_highlight` | 录制用户演示 + 元素高亮确认 |
| 执行器 | 按步执行：navigate/action/extract/wait/ask/approve/loop/subflow/branch，重试+ask-user 自愈 |
| 持久化 | storageDomain（跨实例验证） |
| 定时触发 | trigger.kind=schedule，30s tick 检查 |
| 技能封装 | 每个工作流自动注册为 DSH skill（模型可发现） |
| 斜杠命令 | `/workflows` 列出、`/run <名>` 运行 |
| 场景模板 | 6 类高频场景（批量填表/采集/搬运/批量操作/多账号/巡检） |
| 模板分享 | export/import 参数化 JSON |
| 面板 UI | 工作流 tab：列表/运行/删除/模板/进度 |

### 工作流数据模型
见 `lib/workflow/schema.js`（WorkflowDefinition + ElementTarget 多路语义定位）。

### 测试
```bash
node test/workflow-store-test.mjs      # 保存/校验/持久化
node test/workflow-executor-test.mjs   # 执行器全链路（ask/approve/重试）
```
