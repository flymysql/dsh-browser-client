# DSH Browser Client — 面向非研发人员的网页工作流工具（架构设计）

> 目标用户：日常有重复性网页工作的**非研发人员**。
> 核心价值：用户用**对话**描述痛点 → LLM **理解需求** → LLM **理解站点页面** → 生成可**保存/重跑**的工作流 → 自动执行完成日常自动化。
> 本设计基于：①本地 DSH 源码生态调研（`/Users/jimmy/work/demo/deepseek-harness/packages/` 逐包读源码）②网页自动化社区调研（browser-use / Playwright MCP / Automa 等）③面向非研发自动化产品调研（影刀 RPA / Zapier Agents / Relay / n8n 等）。

---

## 1. 产品定位与差异化

**一句话**：浏览器浮窗里的"对话式 RPA"——非研发用户用大白话描述重复网页工作，AI 理解后生成、保存、自动执行可重跑的工作流。

**差异化（vs 传统 RPA 与现有 AI 工具）**：

| 维度 | 传统 RPA（影刀/UiPath） | 我们的方案 |
|---|---|---|
| 创建方式 | 录制 + 拖拽画布（有学习成本） | **对话描述** + LLM 自动理解 |
| 元素定位 | 硬编码 XPath/CSS（易碎，页面一改就崩） | **LLM 语义定位**（"提交按钮"），运行时重推理抗页面变更 |
| 出错处理 | 静默失败，非研发看不懂日志 | **自然语言报错 + 浮窗求助**（"需要你输验证码"） |
| 信任建立 | 黑盒，不敢放权 | **写操作确认 + 试运行 + 批量抽样 + 实时高亮** |
| 重跑分享 | 流程包导出（技术门槛） | **工作流模板库** + 参数化，他人套用只填自己的变量 |

---

## 2. 总体架构

```
┌─────────────────────── 浏览器（360Chrome/Chrome/Edge） ───────────────────────┐
│                                                                             │
│  ┌─ 任意网页 ──────────────────────────────────────────────────────────┐    │
│  │  content script（isolated world）                                    │    │
│  │   · page_snapshot / page_eval / page_act / page_network（已有）       │    │
│  │   · ★ 新增：page_record（录制用户操作）、page_highlight（元素高亮）    │    │
│  │   · ★ 新增：selector 多路特征提取（语义/角色/文本锚点/坐标/视觉）      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─ 浮窗面板（iframe, chrome-extension://） ────────────────────────────┐    │
│  │  · 对话区（已有）+ ★ 工作流侧栏（步骤列表/实时高亮/进度）              │    │
│  │  · ★ 工作流管理（保存列表/模板市场/一键重跑）                          │    │
│  │  · ★ 确认卡片（写操作审批/试运行结果/验证码求助）                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│        ↕ HTTP RPC + 双向 WS（已有 /ext-api + /ext-api-control）              │
└──────────────────────────────────────────────────────────────────────────────┘
        │
┌─────────────────────── DSH Host（:3081 独立实例） ─────────────────────────┐
│  dsh-browser-host 插件层                                                    │
│   · page_* 工具（已有 7 个）                                                 │
│   · ★ 工作流执行器（WorkflowEngine）：读定义→按步执行→确认点→进度→校验      │
│   · ★ 工作流生成器（对话→结构化工作流定义）                                  │
│   · ★ 录制器（page_record → 步骤抽象 → LLM 提炼语义步骤）                   │
│                                                                             │
│  复用 DSH 现成能力（见 §5 选型清单，避免重复造轮子）：                       │
│   · ctx.storageDomain    → 保存的工作流定义库（跨会话、zod 校验）             │
│   · ctx.userQuestions    → 工作流确认点/追问                                 │
│   · ctx.approval         → 敏感操作安全闸门                                  │
│   · ctx.commands         → 浮窗斜杠命令（/run /workflows）                   │
│   · ctx.skills           → 工作流封装为技能（可发现/可加载）                  │
│   · ctx.subagents        → 多步/并行执行、结构化产出（outputSchema）         │
│   · todo_write           → 分步进度展示                                      │
│   · ctx.attachments      → 截图/产物持久化                                   │
│   · schedule             → 定时触发                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**分层原则**：浏览器扩展负责"感知+操作真实页面"，DSH Host 负责"理解+编排+持久化+确认"。两者通过已有的 token 认证 RPC + 双向 WS 通道连接。

---

## 3. 核心流程：五段式（非研发人员从"有重复工作"到"自动化跑起来"）

调研结论：非研发自动化最顺滑的路径是五段式，每一段我们都有对应的设计：

### ① 说需求（需求理解）
- 浮窗对话区，用户大白话描述："我每天要把后台的订单导出来填进另一个系统"
- **场景模板降门槛**（调研自 n8n/Zapier）：预置 6 类高频场景（批量填表/数据采集/跨系统搬运/批量操作/多账号/定时取数），用户选场景或自由描述
- LLM 用 `ask_user_question`（复用 `tool-ask-user`）按场景追问必要槽位：数据源、字段映射、目标、循环范围、成功标准
- **产出**：结构化工作流需求描述

### ② 演示一遍（意图校准）
- 关键设计（调研自影刀录制 + browser-use 语义定位）：**用户手动做一遍，LLM 边看边语义化记录**
- 扩展 `page_record` 工具：content script 监听用户真实操作（点击/输入/导航），捕获**多路特征**而非硬选择器：
  - 语义角色（role+name：a11y tree）
  - 文本锚点（"按钮「提交」"）
  - 相对位置（"登录框下方的按钮"）
  - 坐标 + 截图兜底
- LLM 把操作序列**抽象为语义步骤**（"点击提交按钮"而非 "click button.submit-btn@(320,450)"）
- **产出**：语义化步骤草稿（抗页面变更的关键）

### ③ 看草稿 + 试运行（可视化 + 信任）
- 浮窗侧栏展示**步骤列表**（自然语言描述每步）
- **dry-run 只读演练**：LLM 走一遍但只读不写，验证每步能否定位到元素
- **批量前抽样**：先对 1 条数据跑，给用户看结果
- 用户确认 → 生成**正式工作流定义**（结构化 JSON，见 §4）

### ④ 保存 + 放量运行（持久化 + 监控）
- 工作流定义存 `ctx.storageDomain`（跨会话、zod 校验）
- 运行中：浮窗侧栏**实时高亮当前操作元素** + `todo_write` 进度条
- **分级确认**（调研自 Relay human-in-the-loop）：
  - 只读操作（查数据/截图）→ 免确认
  - 写操作（提交/删除/下单）→ `ctx.approval` 审批闸门，浮窗弹确认卡片
  - 批量操作 → 抽样确认后放行
- 定时任务 → 复用 `schedule`

### ⑤ 出错自愈（失败恢复 + 信任闭环）
- 页面变更：LLM 运行前校验页面结构与录制时是否一致，不一致时**浮窗告知**"页面变了，我理解成这样对吗？"并请用户确认
- 语义定位失败：LLM 尝试多路特征降级匹配（角色→文本锚点→相对位置→坐标）
- 验证码/人工环节：LLM **浮窗求助**"需要你输一下验证码"，把人当异常处理器
- 全程可回看：会话日志 + 每步操作记录

---

## 4. 工作流数据模型（核心 Schema）

```typescript
// 保存的工作流定义（storage-domain 的 workflows 域）
interface WorkflowDefinition {
  id: string                    // 稳定 id
  name: string                  // "每日订单导出"
  description: string           // 用户可读描述
  createdAt: number
  updatedAt: number
  version: number               // 编辑递增

  // 触发方式
  trigger: {
    kind: 'manual' | 'schedule' // manual 手动 / schedule 定时
    schedule?: { everySeconds?: number; at?: string; timeZone?: string }
  }

  // 作用目标（多标签支持）
  target: {
    urlPattern: string          // 页面 URL 匹配（如 *.taobao.com/seller/*）
    titlePattern?: string
  }

  // 步骤序列（核心）
  steps: WorkflowStep[]

  // 参数（模板套用时只填这些）
  parameters: ParameterDef[]    // [{ name, label, type: 'text'|'file'|'select', required, source: 'ask'|'sheet' }]

  // 确认策略
  approval: {
    confirmOn: ('write' | 'batch' | 'navigate-external')[]
    sampleBeforeBatch?: boolean
  }

  // 校验
  verify: {
    successCriteria: string[]   // 自然语言成功标准（LLM 运行后自检）
    retry?: { maxAttempts: number; onFailure: 'ask-user' | 'skip' | 'stop' }
  }

  // 产物
  output?: { saveScreenshots: boolean; collectTo?: 'workspace' | 'sheet' | 'copy' }
}

type WorkflowStep =
  | { kind: 'navigate'; url: string; waitFor?: string }
  | { kind: 'action'; target: ElementTarget; action: 'click' | 'type' | 'select' | 'scroll' | 'hover'; value?: string | ParameterRef }
  | { kind: 'extract'; target: ElementTarget | 'page'; fields: { name: string; selector: ElementTarget }[] }
  | { kind: 'wait'; condition: 'selector' | 'network-idle' | 'delay'; selector?: string; timeout?: number }
  | { kind: 'ask'; question: string; options?: string[] }   // 运行中问用户
  | { kind: 'approve'; reason: string }                     // 敏感操作确认点
  | { kind: 'loop'; over: 'list-items' | 'table-rows' | ParameterRef; body: WorkflowStep[]; sampleFirst?: boolean }
  | { kind: 'subflow'; ref: string }                        // 引用其他工作流
  | { kind: 'branch'; if: Condition; then: WorkflowStep[]; else?: WorkflowStep[] }

// 元素目标：多路特征（抗页面变更的核心）
interface ElementTarget {
  semantic?: { role: string; name: string }      // a11y: role+name
  textAnchor?: string                            // "按钮「提交」"
  relative?: { anchor: ElementTarget; position: 'above' | 'below' | 'left' | 'right'; offset?: number }
  selector?: string                              // 兜底 CSS（录制时生成）
  indexInViewport?: number                       // 录制时快照中的序号（降级）
  screenshotRef?: string                         // 录制时截图（校验用）
}
```

**设计要点**：
- `ElementTarget` 是**多路特征**，运行时 LLM 依次尝试（语义→文本锚点→相对→选择器→坐标），任一命中即继续——这正是对抗"选择器易碎"（RPA 头号痛点）的核心
- `parameters` 参数化：分享/套用模板时他人只填变量（调研自 n8n/Zapier 模板）
- `approval` + `ask` 步骤类型内建"人在环"确认点（调研自 Relay）
- `verify.successCriteria` 用自然语言，LLM 运行后自检（三层校验：元素命中 + 网络断言 + LLM 自检）

---

## 5. DSH 可复用能力选型清单（避免重复造轮子）

**核心结论（源码级确认）**：DSH **没有**现成的"保存/重放工作流"机制（`workflow` 包明确 `No saved or nested workflows`），但**每一环都有现成能力可直接复用**——这正是本方案的价值：我们只做"工作流定义 + 执行器 + 浏览器执行"这一层，其余全部站在 DSH 生态上。

| 优先级 | DSH 包 | 复用方式 | 用途 |
|---|---|---|---|
| ⭐⭐⭐ P0 | `storage/storage-domain`（`ctx.storageDomain`） | **直接依赖** | **工作流定义库**（跨会话、zod 校验、可路由 json/sqlite 后端）——工作流保存的落盘处 |
| ⭐⭐⭐ P0 | `interaction/user-questions` + `tool-ask-user` | **直接依赖** | 生成期追问缺参 / 运行中问用户（`ask` 步骤） |
| ⭐⭐⭐ P0 | `interaction/user-approval`（`ctx.approval`） | **直接依赖** | 敏感网页操作的安全闸门（写操作/批量确认） |
| ⭐⭐⭐ P0 | `interaction/commands`（`ctx.commands`） | **直接依赖** | 浮窗斜杠命令：`/run <wf>` `/workflows` `/record` |
| ⭐⭐⭐ P0 | `skill/*`（`ctx.skills` + `tool-skill`） | **直接依赖** | **把工作流封装为技能**——验证有效的工作流沉淀为 SKILL.md，可发现/可加载/可复用 |
| ⭐⭐ P1 | `subagent/*`（`ctx.subagents` + `outputSchema`） | **直接依赖（多步/并行）** | 多步/并行执行、结构化步骤产出（每步产出 schema 校验） |
| ⭐⭐ P1 | `todo/tool-todo` | **直接依赖** | 工作流运行分步进度展示（浮窗订阅 `todo/write`） |
| ⭐⭐ P1 | `attachment/*`（`ctx.attachments`） | **直接依赖（截图场景）** | 截图/产物持久化（存 ref 不存 base64） |
| ⭐⭐ P1 | `schedule/schedule` | **可选依赖** | 定时触发工作流（注意 session-local 限制） |
| ⭐ P2 | `workflow/*` | **参考实现** | 自建执行器的缝设计（Definition/Provider/Consumer 三段式）；本身不支持保存重放，不直接当底座 |
| ⭐ P2 | `code-runtime/*`（Code Mode） | **可选依赖** | 把网页操作暴露为 code bindings，脚本化编排单步 |
| ⭐ P2 | `plan/plan-mode` | **参考实现** | "规划→确认→执行"交互骨架 + session-projection 视图范例 |
| ⭐ P2 | `session-query/session-log-export`（`/export`） | **可选依赖** | 导出工作流运行轨迹（会话 ZIP） |
| ⭐ P2 | `session-query/tool-session-query` | **可选依赖** | 生成期检索历史相似任务复用经验 |
| ⭐ P2 | `interaction/permission-presets` | **可选依赖** | 面向非研发用户的权限档位抽象 |
| — | `hooks/*` | 不直接复用 | CC/Codex 迁移桥；我们的钩子应写成挂原生扩展点的普通 Cordis 插件 |

**三条贯穿性结论**：
1. **持久化双轨**：跨会话共享的工作流定义库 → `storage-domain`；单次运行状态/进度 → session 事件日志 + fold + projection（复用 schedule/plan/todo 的成熟范式）
2. **`workflow` 包不是底座**：它是"模型现写脚本、前台一次性 fan-out"，不支持保存/重放。执行层优先 `subagent`（多步/并行）或自建执行器
3. **确认与安全现成**：`userQuestions` + `approval` + `commands` + `permission-presets` 构成完整"人在环"交互面，直接搭上，不自造协议

---

## 6. 社区借鉴清单（避免重复造轮子 + 吸收最佳实践）

> 注：本轮 `web_search` 因余额不可用，以下基于子代理的领域知识调研；标注 ⚠️ 的项建议在选型定稿前联网核实。

### 6.1 直接形态参考
- **Automa**（开源 Chrome 扩展）⚠️ —— 与我们的插件形态最像：浏览器内建工作流节点画布、触发器、保存/重跑。**其工作流数据结构和触发器设计直接可借鉴**（但它是"拖拽节点"模式，我们升级为"对话生成"）
- **browser-use**（GitHub）⚠️ —— "LLM 实时理解 DOM + 截图 + 坐标操作"闭环，与我们已实现的 page_* 一致；其 **DOM 索引化 action schema** 和**多重定位特征**值得吸收。需核实其是否已有 workflow/录制能力
- **Playwright MCP** —— 其工具集是权威参照，我们已覆盖大部分（snapshot/eval/act/navigate/wait/screenshot/network），**建议补齐**：显式 `wait_for`（重放成败关键）、`file_upload`（文件上传）、`handle_dialog`（alert/confirm）、多标签 `tabs`、`drag`、`console` 监听

### 6.2 交互模式参考
- **Zapier Agents / Relay.app** —— "自然语言描述→LLM 追问→生成步骤草稿→用户确认"；Relay 的 **human-in-the-loop 审批节点** 直接对应我们的 `approval` 步骤
- **影刀 RPA / 八爪鱼** —— 录制器 + 智能结构识别 + 可视化点选 + 多选择器容错；**元素集中管理**（改一处生效）
- **n8n templates / Zapier 模板库** —— 工作流**参数化模板** + 一键套用 + 只填自己的凭证，非研发最低门槛入口
- **智谱清言浏览器助手等** —— 浮窗侧边栏（不遮挡页面）+ 悬浮球唤起 + **行动前元素高亮**

### 6.3 抗脆弱设计（RPA 头号痛点）
- **语义定位优先**：a11y tree（role+name）主定位 + 索引化 DOM 补充 + 截图仅作校验兜底（browser-use 验证过）
- **录制时存多路特征**（Automa/影刀模式），运行时降级匹配
- **页面结构校验**：每次运行前校验与录制时一致性，不一致浮窗求助

### 6.4 非研发产品设计要点（五大支柱）
1. **需求理解** = 对话澄清 + 场景模板（不让用户面对空白画布）
2. **工作流可视化** = 步骤列表 + 实时元素高亮（所见即所得）
3. **运行监控** = 进度 + 可回看记录
4. **失败恢复** = 语义定位抗脆弱 + 浮窗求助自愈（把人当异常处理器）
5. **信任建立** = dry-run + 抽样 + 写操作分级确认 + 全程审计

---

## 7. 实现路线（基于已有进度）

### 阶段 A：工作流定义与保存（地基）
- [ ] 定义 `WorkflowDefinition` schema（§4），用 `ctx.storageDomain` 建 `workflows` 域
- [ ] 浮窗 `/workflows` 命令 + 保存/列表/删除/编辑 UI
- [ ] 场景模板库（6 类高频场景的预置模板）

### 阶段 B：对话→工作流生成器
- [ ] 需求理解对话流（`ask_user_question` 追问槽位）
- [ ] 录制器 `page_record`（content script 捕获用户操作 + 多路特征提取）
- [ ] LLM 语义抽象（操作序列 → 语义步骤 → `WorkflowDefinition`）
- [ ] 草稿预览 + 用户确认（浮窗侧栏展示步骤）

### 阶段 C：执行器（核心）
- [ ] `WorkflowEngine`：读定义 → 按步执行 → `todo_write` 进度 → `approval` 确认点 → `ask` 步骤
- [ ] 语义定位运行时解析（多路特征降级匹配）
- [ ] 校验层（元素命中 + 网络断言 + LLM 自检 successCriteria）
- [ ] 出错自愈（页面变更检测 + 浮窗求助 + 重试策略）

### 阶段 D：打磨与扩展
- [ ] 批量/循环步骤（`loop` + 抽样确认）
- [ ] 定时触发（复用 `schedule`）
- [ ] 工作流封装为技能（`ctx.skills`）——沉淀到 `~/.dsh/skills/`
- [ ] 模板分享（导出参数化模板 JSON）
- [ ] 浮窗 UI 升级：工作流侧栏、实时高亮、确认卡片

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 语义定位在复杂 SPA 上失败 | 多路特征降级 + 录制时截图兜底 + 页面结构校验求助 |
| 非研发用户描述不清需求 | 场景模板 + 结构化追问（不开放空白画布） |
| 敏感操作误执行 | `approval` 分级闸门 + 批量抽样 + dry-run + 全程审计 |
| 页面频繁变更维护成本 | 语义定位抗变更 + 变更检测浮窗求助（比传统 RPA 硬选择器强） |
| 工作流执行中需要人工输入（验证码） | `ask` 步骤浮窗求助，把人当异常处理器 |
| DSH 版本差异（当前 rc.8 vs 源码 rc.11） | 复用能力以 Inspect Provider 实测为准；`storage-domain`/`userQuestions`/`approval`/`commands`/`skills` 均在 rc.8 可用 |

---

## 9. 待核实项（web_search 恢复后）

1. ⚠️ browser-use 是否已有官方 workflow/录制重放能力（迭代快，曾有 workflow-use 讨论）
2. ⚠️ Automa 最新工作流数据结构与触发器设计细节
3. ⚠️ Playwright MCP / chrome-devtools-mcp 最新工具清单（精确补齐工具遗漏）
4. ⚠️ 影刀/八爪鱼最新"AI 对话式创建"进展（国内 RPA 已在加 AI 层）

---

*本文档与实现代码同步演进；实现细节以代码注释与 README 为准。*

---

## 10. 探索式工作流生成（Explore Mode）— 复杂需求的关键能力

### 为什么需要
用户需求常复杂到 LLM 无法一次给出完整方案（页面结构未知、操作顺序需试错、依赖登录/权限等前置状态）。探索模式让 LLM **边操作边学**，最终把验证过的正确路径提取为工作流。

### 工作方式（6 个 explore_* 工具）

```
explore_start  开启探索（记录目标）
   ↓
explore_act   尝试页面操作（结果记入轨迹，成功/失败都记录）
explore_extract 读取页面数据（作为目标达成的证据）
explore_ask   探索中向用户求助（验证码/确认/指引）
explore_check 校验目标条件是否达成（"购物车有商品了吗"）
   ↓
explore_finish 提炼：只保留 success=true 的步骤 → 保存为工作流
```

### 路径提炼（核心）
- 轨迹记录**每一次尝试**（含失败的）
- 提炼时**只保留 success=true 的操作步骤**，丢弃"尝试→失败→换方式"的中间过程
- 生成的工作流干净、可重跑，且带成功标准（来自 explore_check 的已验证条件）

### 验证
`test/explore-mode-test.mjs`：模拟"未登录直接加购→失败 → 先登录→成功 → 加购→成功 → 校验"，
提炼出 2 步有效路径（失败的 1 步被丢弃）——E2E 通过。

---

## 11. 非研发人员交互设计

### 沟通规范（注册为系统提示词段）
LLM 与普通用户对话时遵循：
1. **口语需求复述确认**（"你是想每天自动把订单导到表格，对吗？"）
2. **不用术语**（不说"选择器/脚本/DOM"，说"这个按钮/输入框"）
3. **主动引导补全**（"订单从哪个后台？导到哪？每天几点？"）
4. **失败说人话**（"页面没找到这个按钮，可能位置变了" + 给选项）
5. **探索透明**（正在尝试/卡住/需要验证码，实时大白话说明）
6. **进度可见**（"正在做第几步 / 共几步"，做完说结果）

### 面板交互
- 探索模式**状态横幅**（🧭 探索中 → 实时显示当前动作 → 🎉 完成）
- 确认对话框（ask/approve）已有，探索中求助复用
- 场景模板 + 引导式提问（不让普通用户面对空白画布）

### 探索模式成熟度增强（v2）
1. **导航自动补全**：explore_finish 自动为提炼的工作流补上起始 URL 的 `navigate + wait` 前缀（及页面切换处的 navigate），重跑时从正确起点开始；target.urlPattern 自动从起始 URL 推导域名。
2. **explore_undo 回退**：探索走错路径时可撤销上一步（移除轨迹 + 页面回退），避免在错误路径上堆叠操作。
3. **客观成功判定**：explore_act 返回操作后页面快照，LLM 对比观察结果判定 success（而非主观臆断）；失败时建议 explore_undo 换路径。
4. **站点路径记忆**：explore_start 时若当前域名已有验证过的工作流，作为起点提示注入，减少重复探索同一站点的常见路径。
5. **explore_act 支持 navigate**：探索中导航作为 navigate 步骤记录，参与路径提炼。

### 验证
`test/explore-mode-test.mjs` 覆盖：导航记录 → 失败丢弃 → 正确路径 → 校验 → 提炼（含 navigate+wait 前缀、URL 推导、成功标准继承）；explore_undo 回退；navigate-only 工作流拒绝。E2E 全通过。
