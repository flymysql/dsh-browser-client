/**
 * templates.js — 场景模板库（6 类高频重复网页工作）。
 *
 * 面向非研发用户的最低门槛入口：用户选一个场景模板，LLM 按该场景的
 * 必要槽位追问（数据源/字段/目标/循环范围/成功标准），生成具体工作流。
 * 调研自非研发自动化产品模式（影刀/八爪鱼/Zapier/n8n）的场景分类。
 */

/** 场景模板定义。 */
export const SCENARIO_TEMPLATES = [
  {
    id: 'batch-form-fill',
    name: '批量填表',
    description: '把表格/文档里的数据逐行填进网页表单并提交（报销、报名、录入）。',
    category: 'form',
    slots: [
      { name: '数据源', type: 'text', hint: '数据在哪？（Excel 文件路径 / 粘贴的表格 / 其他页面）' },
      { name: '目标表单', type: 'url', hint: '要填的网页表单地址' },
      { name: '字段映射', type: 'text', hint: '表格列对应表单哪些字段？' },
      { name: '提交方式', type: 'select', options: ['逐条提交', '填完一起提交'] }
    ],
    steps: [
      { kind: 'ask', question: '请提供数据源（Excel/粘贴表格）和目标表单地址' },
      { kind: 'loop', over: { type: 'parameter', name: 'dataRows' }, sampleFirst: true, body: [
        { kind: 'navigate', url: { type: 'parameter', name: 'formUrl' } },
        { kind: 'action', action: 'type', target: { textAnchor: '表单字段' }, value: { type: 'parameter', name: 'fieldValue' } },
        { kind: 'action', action: 'click', target: { textAnchor: '按钮「提交」' } },
        { kind: 'wait', condition: 'network-idle', timeout: 5000 }
      ] }
    ],
    parameters: [
      { name: 'dataRows', label: '数据行', type: 'text', required: true },
      { name: 'formUrl', label: '表单地址', type: 'text', required: true },
      { name: 'fieldValue', label: '字段值', type: 'text', required: true }
    ]
  },
  {
    id: 'data-extract',
    name: '数据采集/查数据',
    description: '从网页/后台列表批量抓取字段导出到表格（对账、找线索、监控价格）。',
    category: 'extract',
    slots: [
      { name: '目标页面', type: 'url', hint: '要采集数据的页面地址' },
      { name: '采集字段', type: 'text', hint: '要抓哪些字段？（如：标题、价格、销量）' },
      { name: '翻页方式', type: 'select', options: ['自动翻页', '只抓当前页', '指定页数'] },
      { name: '导出格式', type: 'select', options: ['CSV', 'Excel', '复制到剪贴板'] }
    ],
    steps: [
      { kind: 'navigate', url: { type: 'parameter', name: 'pageUrl' } },
      { kind: 'extract', target: 'page', fields: [] },
      { kind: 'loop', over: 'list-items', sampleFirst: true, body: [
        { kind: 'extract', target: { semantic: { role: 'listitem', name: 'item' } }, fields: [] }
      ] },
      { kind: 'ask', question: '需要继续翻页采集吗？' }
    ],
    parameters: [
      { name: 'pageUrl', label: '目标页面', type: 'text', required: true },
      { name: 'fields', label: '采集字段', type: 'text', required: true }
    ]
  },
  {
    id: 'cross-system-transfer',
    name: '跨系统搬运',
    description: '从 A 系统查到数据，复制粘贴到 B 系统（OA↔ERP、客服工单↔CRM）。',
    category: 'transfer',
    slots: [
      { name: '源系统', type: 'url', hint: '数据来源系统页面' },
      { name: '目标系统', type: 'url', hint: '数据要写入的系统页面' },
      { name: '搬运字段', type: 'text', hint: '搬运哪些数据？' },
      { name: '处理方式', type: 'select', options: ['原样搬运', '转换后搬运'] }
    ],
    steps: [
      { kind: 'navigate', url: { type: 'parameter', name: 'sourceUrl' } },
      { kind: 'extract', target: 'page', fields: [] },
      { kind: 'navigate', url: { type: 'parameter', name: 'targetUrl' } },
      { kind: 'action', action: 'type', target: { textAnchor: '目标字段' }, value: { type: 'parameter', name: 'data' } },
      { kind: 'action', action: 'click', target: { textAnchor: '按钮「保存」' } }
    ],
    parameters: [
      { name: 'sourceUrl', label: '源系统地址', type: 'text', required: true },
      { name: 'targetUrl', label: '目标系统地址', type: 'text', required: true },
      { name: 'data', label: '搬运数据', type: 'text', required: true }
    ]
  },
  {
    id: 'batch-operation',
    name: '批量操作',
    description: '对列表逐条执行同一动作（审批、打标签、发消息、下载附件）。',
    category: 'operation',
    slots: [
      { name: '目标列表', type: 'url', hint: '要操作的列表页面' },
      { name: '操作动作', type: 'text', hint: '每条要做什么？（审批/打标签/下载…）' },
      { name: '处理范围', type: 'select', options: ['全部', '前 N 条', '按条件筛选'] },
      { name: '确认方式', type: 'select', options: ['先跑 1 条给我看', '全部直接跑'] }
    ],
    steps: [
      { kind: 'navigate', url: { type: 'parameter', name: 'listUrl' } },
      { kind: 'loop', over: 'list-items', sampleFirst: { type: 'parameter', name: 'confirmFirst' }, body: [
        { kind: 'action', action: 'click', target: { textAnchor: '操作按钮' } },
        { kind: 'approve', reason: '执行批量操作' }
      ] }
    ],
    parameters: [
      { name: 'listUrl', label: '列表地址', type: 'text', required: true },
      { name: 'confirmFirst', label: '先抽样确认', type: 'boolean', required: false }
    ]
  },
  {
    id: 'multi-account',
    name: '多账号/多环境重复',
    description: '同一操作在多个账号/店铺/门店后台各做一遍。',
    category: 'account',
    slots: [
      { name: '操作页面', type: 'url', hint: '要重复操作的页面' },
      { name: '账号列表', type: 'text', hint: '哪些账号？（账号密码或已登录环境）' },
      { name: '操作内容', type: 'text', hint: '每个账号要做什么？' }
    ],
    steps: [
      { kind: 'loop', over: { type: 'parameter', name: 'accounts' }, body: [
        { kind: 'navigate', url: { type: 'parameter', name: 'pageUrl' } },
        { kind: 'action', action: 'type', target: { textAnchor: '账号输入框' }, value: { type: 'parameter', name: 'account' } },
        { kind: 'action', action: 'click', target: { textAnchor: '按钮「登录」' } },
        { kind: 'ask', question: '切换到下一个账号继续？' }
      ] }
    ],
    parameters: [
      { name: 'pageUrl', label: '操作页面', type: 'text', required: true },
      { name: 'accounts', label: '账号列表', type: 'text', required: true }
    ]
  },
  {
    id: 'scheduled-check',
    name: '定时巡检/取数',
    description: '每天固定去几个后台截图/抄数字/做日报。',
    category: 'schedule',
    slots: [
      { name: '巡检页面', type: 'url', hint: '要巡检的后台页面' },
      { name: '要看的数字', type: 'text', hint: '每天要抄哪些指标？' },
      { name: '执行频率', type: 'select', options: ['每天', '每周', '每小时'] },
      { name: '结果去向', type: 'select', options: ['发到会话', '存到工作区', '截图保存'] }
    ],
    steps: [
      { kind: 'navigate', url: { type: 'parameter', name: 'pageUrl' } },
      { kind: 'extract', target: 'page', fields: [] },
      { kind: 'ask', question: '本次巡检结果已汇总，需要截图存档吗？' }
    ],
    parameters: [
      { name: 'pageUrl', label: '巡检页面', type: 'text', required: true },
      { name: 'metrics', label: '要看的指标', type: 'text', required: true }
    ],
    triggerHint: { kind: 'schedule', everySeconds: 86400 }
  }
]

/** 按 id 找一个模板。 */
export function findTemplate(id) {
  return SCENARIO_TEMPLATES.find((t) => t.id === id)
}

/** 所有模板的轻量摘要（供面板渲染）。 */
export function templateSummaries() {
  return SCENARIO_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    slotCount: t.slots.length
  }))
}
