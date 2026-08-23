# DSH Browser Client — 用户指南

DSH Browser Client 是一个浏览器扩展 + DSH host 插件的组合，让你在任意网页右下角的浮窗里，通过自然语言让 DeepSeek Harness 理解并操作当前页面。

## 安装

### 1. 安装 host 插件（DSH 侧）

在 DSH profile 的 `cordis.patch.yml` 中插入（或直接使用项目自带的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-browser-host
      name: 'dsh-browser-host'   # 或本地路径: '/path/to/dsh-browser-host/lib/index.js'
      config:
        extPrefix: /ext-api
        extEventsPath: /ext-events.mux
        persistToken: true
        tokenFile: $DSH_HOME/browser-client-token   # 默认
        toolTimeoutMs: 60000
```

重启 DSH。启动日志会打印：

```
[dsh-browser-host] extension token: <32-hex-token>
[dsh-browser-host] registered tool page_snapshot
[dsh-browser-host] registered tool page_eval
... (6 个 page_* 工具)
```

Token 也会写入 `$DSH_HOME/browser-client-token`（0600 权限）。

### 2. 安装浏览器扩展

1. 打开 Chrome/Edge → `chrome://extensions`
2. 打开"开发者模式"
3. 点"加载已解压的扩展程序"，选择目录：`dsh-browser-host/browser-ext/extension`
4. 扩展图标出现在工具栏（右下角浮窗气泡会自动注入每个页面）

## 首次配置

1. 点击扩展图标（或页面上 DSH 浮窗气泡）打开面板
2. 点 ⚙ 设置：
   - **Host 地址**：`http://127.0.0.1:3080`（或你的 DSH 端口）
   - **Token**：`browser-client-token` 文件内容（或启动日志里的 token）
   - **当前页面目录**：可选，DSH 会话的工作目录
3. 保存 → 面板顶部状态变为"已连接"

## 使用

### 让 LLM 理解当前页面

在浮窗输入框问：

```
这个页面现在显示什么？
```

LLM 会调用 `page_snapshot` 工具读取页面结构化快照（URL、标题、可见文本、可交互元素清单），然后总结给你。

### 读取页面深层数据

```
页面上有哪些商品？分别多少钱？
```

LLM 会用 `page_snapshot` 读取可见内容；如需页面内部数据（接口返回、框架状态），它会用 `page_eval` 执行 JS 精确提取。

### 操作页面

```
把第一个商品加入购物车
```

LLM 会用 `page_act`（点击坐标/选择器）、必要时 `page_navigate` / `page_wait`，操作后重新快照验证效果。

### 截图查看

```
截个图看看现在页面什么样
```

`page_screenshot` 调用浏览器截图（需要视觉模型看图片）。

## 页面工具一览

| 工具 | 作用 |
|---|---|
| `page_snapshot` | 当前页结构化视图：URL/标题/可见文本/交互元素（带坐标） |
| `page_eval` | 在页面 MAIN world 执行任意 JS，读内部数据 |
| `page_act` | 点击/输入/滚动/键盘/清除（坐标或选择器定位） |
| `page_navigate` | 跳转/后退/前进/刷新 |
| `page_wait` | 等待选择器出现/网络空闲/延时 |
| `page_screenshot` | 截图（视口/元素/整页），落盘工作区 |
| `page_network` | 读取页面 fetch/XHR 请求（URL/方法/状态/响应体预览），理解页面数据流 |

> **命名说明**：工具名使用下划线（`page_snapshot`）而非点号（`page.snapshot`）——腾讯 intranet 网关拒绝含点号的工具名（`invalid_parameter_value`）。

## 安全

- Token 仅本机回环通信，权限 0600，不写日志
- 页面内容脚本只能通过 `chrome.runtime.sendMessage` 与面板通信，页面 JS 无法触达 DSH 会话
- 面板 iframe 为 `chrome-extension://` origin，页面无法注入

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| 面板显示"未连接" | Token 未配置或错误；确认 DSH 已启动且插件已挂载 |
| "extension not connected" | 浮窗面板未打开——页面工具依赖面板的 control 连接，关掉面板工具会超时 |
| content script 未响应 | 页面加载后未刷新；刷新页面重试 |
| 工具调用报网关错误 | 确认工具名无点号；检查 DSH 日志与腾讯网关日志（`$DSH_HOME/logs/tencent-intranet/`） |
