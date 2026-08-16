// dsh-balance-stats 宿主端冒烟测试 v0.2.0:
// 用假 cordis 上下文驱动 apply, 验证按【事件时刻】的峰谷分层计价、
// 明细 breakdown 结构与 /balance-stats/stats 路由端到端输出。
import { apply } from '../src/index.js'

// 官方峰谷生效时刻: 2026-08-17T00:00+08:00 = 1786896000000
const CUTOFF = 1786896000000
const T_LEGACY = CUTOFF - 3600e3   // 8-16 23:00 北京时间 → legacy 旧价
const T_PEAK = CUTOFF + 10 * 3600e3 // 8-17 10:00 北京时间 → 高峰
const T_OFFPEAK = CUTOFF + 8 * 3600e3 // 8-17 08:00 北京时间 → 空闲

const events = [
  { time: T_LEGACY, type: 'request/header', data: { header: { config: { model: 'deepseek-v4-pro' } } } },
  { time: T_LEGACY, type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 120 } } } },
  { time: T_LEGACY, type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 700, cacheReadTokens: 300, cacheWriteTokens: 60, outputTokens: 150 } } } }, // 同 (turn,step) 替换样本
  { time: T_PEAK, type: 'request/context', data: { model: 'deepseek-v4-flash' } },
  { time: T_PEAK, type: 'assistant/message', data: { turn: 1, step: 0, usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 10, outputTokens: 40 } } },
  { time: T_PEAK, type: 'compaction/summary', data: { compactionId: 'c1', model: 'deepseek-v4-pro', usage: { inputTokens: 1000, cacheReadTokens: 50000, cacheWriteTokens: 100, outputTokens: 300 } } },
  { time: T_PEAK, type: 'session/title-llm-request', data: { titleProvider: 'p1', route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, messages: [], system: '', maxTokens: 64 } },
  { time: T_PEAK, type: 'web/deepseek-search-llm-request', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] } },
  { time: T_PEAK, type: 'session/title', data: { title: '真实标题A', messageSeqs: [], source: { kind: 'user' } } },
]
const sessionA = { id: 'session-aaaa', header: { title: '旧的头字段(不应被采用)', cwd: 'C:\\Users\\hhy99' }, events, title: '' }
const sessionB = { id: 'session-bbbb', header: { cwd: 'E:\\乐乐课堂' }, events: [
  { time: T_OFFPEAK, type: 'request/header', data: { header: { config: { model: 'deepseek-v4-pro' } } } },
  { time: T_OFFPEAK, type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 80 } } },
], title: '' }

// 磁盘上的历史会话(冷读路径): 未加载到内存, 经 ctx.sessionPersistence 提供
const T_OLD = CUTOFF - 26 * 3600e3 // 8-15 22:00 北京时间 → legacy 旧价, 独立一天
const coldEvents = [
  { time: T_OLD, type: 'request/header', data: { header: { config: { model: 'deepseek-v4-pro' } } } },
  { time: T_OLD, type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 30 } } },
  { time: T_OLD, type: 'session/title', data: { title: '旧会话标题', messageSeqs: [], source: { kind: 'user' } } },
]
const coldSnapshot = { header: { id: 'session-old', cwd: 'D:\\old' }, revision: 'rev-1' }
const fakePersistence = {
  listSnapshots: async () => [coldSnapshot],
  readFrom: async (id, fromSeq) => {
    if (id === 'session-old' && fromSeq === 0) return { meta: { id: 'session-old', cwd: 'D:\\old' }, events: coldEvents }
    return { meta: { id, cwd: '' }, events: [] }
  },
}

const routes = new Map()
let projectionDef = null
const ctx = {
  get: (name) => {
    if (name === 'sessionPersistence') return fakePersistence
    if (name === 'sessions') return { get: () => undefined }
    return undefined
  },
  logger: { warn: (...a) => console.log('  [warn]', ...a) },
  effect: () => () => {},
  inject: (_deps, fn) => {
    fn({
      effect: (f) => { f(); return () => {} },
      webServer: { register: (r) => routes.set(r.path, r) },
      sessions: { list: () => [sessionA, sessionB], get: () => undefined },
      sessionProjections: {
        register: (def) => { projectionDef = def },
        snapshot: (session) => {
          let state = projectionDef.init()
          for (const ev of session.events) state = projectionDef.apply(state, ev)
          return { asOfSeq: session.events.length - 1, values: { balanceConsumption: projectionDef.view(state) } }
        },
      },
    })
  },
}

apply(ctx, {})

if (!projectionDef) throw new Error('projection 未注册')
if (!routes.has('/balance-stats/query') || !routes.has('/balance-stats/stats')) throw new Error('路由未注册')

const res = { writeHead: (s) => { res.status = s }, end: (b) => { res.body = b } }
await routes.get('/balance-stats/stats').handler({ method: 'GET', url: '/balance-stats/stats' }, res)
const json = JSON.parse(res.body)

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg) }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

// ── token 汇总(与 v0.1 相同的去重语义) ──
assert(json.totals.sessionCount === 3, '会话数 = 3(含冷读历史会话), got ' + json.totals.sessionCount)
assert(json.totals.workspaceCount === 3, '工作区数 = 3, got ' + json.totals.workspaceCount)
assert(json.sessions[0].workspace === 'C:\\Users\\hhy99', '最新会话(sessionA)的工作区 = C:\\Users\\hhy99, got ' + json.sessions[0].workspace)
assert(json.sessions.find((s) => s.id === 'session-bbbb').workspace === 'E:\\乐乐课堂', 'sessionB 工作区 = E:\\乐乐课堂')
assert(json.totals.tokens.uncachedInput === 2300, '未命中输入 = 2300(含冷读200+压缩1000), got ' + json.totals.tokens.uncachedInput)
assert(json.totals.tokens.cacheRead === 50450, '缓存命中 = 50450(含冷读50+压缩50000), got ' + json.totals.tokens.cacheRead)
assert(json.totals.tokens.cacheWrite === 170, '缓存写入 = 170(含压缩100), got ' + json.totals.tokens.cacheWrite)
assert(json.totals.tokens.output === 600, '输出 = 600(含冷读30+压缩300), got ' + json.totals.tokens.output)

// ── 分层计价(官方口径) ──
// pro/legacy 合并(内存 700/300/60/150 + 冷读 200/50/0/30):
//   (900+60)×3 + 350×0.025 + 180×6 = 3968.75 /1e6 → 0.003969
// flash/peak: (100+10)×3.0 + 0×0.10 + 40×9.0 = 690 /1e6 = 0.00069
// pro/offpeak: (300+0)×4.5 + 100×0.15 + 80×13.5 = 2445 /1e6 = 0.002445
// pro/peak(压缩摘要): (1000+100)×9 + 50000×0.30 + 300×27 = 33000 /1e6 = 0.033
// 冷读会话: (200+0)×3 + 50×0.025 + 30×6 = 781.25 /1e6 = 0.000781
// 合计 0.00710375 + 0.033 = 0.04010375 → round6 = 0.040104
assert(near(json.totals.cost, 0.040104), '总花费 = 0.040104, got ' + json.totals.cost)

const byModel = Object.fromEntries(json.breakdown.map((g) => [g.model, g]))
assert(byModel['deepseek-v4-pro'] !== undefined && byModel['deepseek-v4-flash'] !== undefined, 'breakdown 含两个模型')
const proTiers = Object.fromEntries(byModel['deepseek-v4-pro'].tiers.map((t) => [t.tier, t]))
const flashTiers = Object.fromEntries(byModel['deepseek-v4-flash'].tiers.map((t) => [t.tier, t]))
assert(proTiers.legacy && proTiers.offpeak && proTiers.peak, 'pro 有 legacy+offpeak+peak 三个时段')
assert(flashTiers.peak, 'flash 有 peak 时段')

assert(near(proTiers.legacy.cost, 0.003969), 'pro legacy 花费(合并冷读), got ' + proTiers.legacy.cost)
assert(near(proTiers.legacy.prices.cacheMiss, 3) && near(proTiers.legacy.prices.cacheHit, 0.025) && near(proTiers.legacy.prices.output, 6), 'pro legacy 官方旧价')
assert(proTiers.legacy.buckets.uncachedInput === 900 && proTiers.legacy.buckets.cacheRead === 350 && proTiers.legacy.buckets.cacheWrite === 60 && proTiers.legacy.buckets.output === 180, 'pro legacy 分桶正确(替换样本去重 + 冷读合并)')

assert(near(proTiers.peak.cost, 0.033), 'pro peak 压缩摘要花费 = 0.033, got ' + proTiers.peak.cost)
assert(near(proTiers.peak.prices.cacheMiss, 9) && near(proTiers.peak.prices.cacheHit, 0.3) && near(proTiers.peak.prices.output, 27), 'pro peak 官方高峰价')
assert(proTiers.peak.buckets.uncachedInput === 1000 && proTiers.peak.buckets.cacheRead === 50000 && proTiers.peak.buckets.cacheWrite === 100 && proTiers.peak.buckets.output === 300, 'pro peak 分桶 = 压缩摘要样本')

assert(near(flashTiers.peak.cost, 0.00069), 'flash peak 花费, got ' + flashTiers.peak.cost)
assert(near(flashTiers.peak.prices.cacheMiss, 3.0) && near(flashTiers.peak.prices.cacheHit, 0.10) && near(flashTiers.peak.prices.output, 9.0), 'flash peak 官方高峰价')

assert(near(proTiers.offpeak.cost, 0.002445), 'pro offpeak 花费, got ' + proTiers.offpeak.cost)
assert(near(proTiers.offpeak.prices.cacheMiss, 4.5) && near(proTiers.offpeak.prices.cacheHit, 0.15) && near(proTiers.offpeak.prices.output, 13.5), 'pro offpeak 官方空闲价')

// ── 官方定价 payload ──
assert(json.pricing !== null && json.pricing.models['deepseek-v4-pro'].peak.output === 27, '官方定价表 payload')
assert(typeof json.pricing.note === 'string' && json.pricing.note.length > 20, '官方说明文案')
assert(typeof json.pricing.billingRule === 'string' && json.pricing.billingRule.length > 10, '官方扣费规则文案')
assert(json.pricing.source === 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', '官方定价页链接')
assert(json.pricing.usageUrl === 'https://platform.deepseek.com/usage', '官方用量页链接')

// ── 会话明细行带 breakdown ──
assert(json.sessions.length === 3, '会话明细 3 行(含冷读), got ' + json.sessions.length)
assert(Array.isArray(json.sessions[0].breakdown) && json.sessions[0].breakdown.length > 0, '会话行带分层明细')

// ── 冷读历史会话 ──
const coldRow = json.sessions.find((s) => s.id === 'session-old')
assert(coldRow !== undefined, '冷读会话出现在明细中')
assert(coldRow.title === '旧会话标题', '冷读会话标题取自 session/title 事件, got ' + coldRow.title)
assert(coldRow.workspace === 'D:\\old', '冷读会话工作区 = D:\\old, got ' + coldRow.workspace)
assert(near(coldRow.cost, 0.000781), '冷读会话花费 = 0.000781, got ' + coldRow.cost)
assert(json.cold !== undefined && json.cold.status === 'ready' && json.cold.count === 1, 'cold 状态字段, got ' + JSON.stringify(json.cold))

// ── 标题与 Web 界面同源(session/title 事件, 用户改名即追加此类事件) ──
assert(json.sessions[0].title === '真实标题A', '标题取自 session/title 事件, got ' + JSON.stringify(json.sessions[0].title))
assert(json.sessions[0].title !== '旧的头字段(不应被采用)', 'header.title 不再被采用')
assert(json.sessions.find((s) => s.id === 'session-bbbb').title === '', '无标题事件的会话标题为空字符串')

// ── 逐日花费(KPI: 今日/本月/续航 的数据基础, 时区无关断言) ──
const round6 = (n) => Math.round(n * 1e6) / 1e6
const dayOf = (ts) => {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const expectByDay = new Map()
const addDay = (ts, cost) => expectByDay.set(dayOf(ts), round6((expectByDay.get(dayOf(ts)) ?? 0) + cost))
addDay(T_LEGACY, 0.003188)  // pro legacy 3187.5/1e6
addDay(T_PEAK, 0.00069 + 0.033) // flash peak 690/1e6 + 压缩摘要 33000/1e6
addDay(T_OFFPEAK, 0.002445) // pro offpeak 2445/1e6
addDay(T_OLD, 0.000781)     // 冷读会话 pro legacy 781.25/1e6
assert(Array.isArray(json.totals.days) && json.totals.days.length === expectByDay.size, '逐日数据条数 = ' + expectByDay.size + ', got ' + (json.totals.days ?? []).length)
const gotByDay = new Map((json.totals.days ?? []).map((d) => [d.day, d.cost]))
for (const [k, v] of expectByDay) {
  assert(near(gotByDay.get(k), v, 1e-6), 'day ' + k + ' 花费 = ' + v + ', got ' + gotByDay.get(k))
}
// 逐日 token 分桶(8-17 当天 = flash 主请求 + 压缩摘要 + sessionB 空闲请求, 三者同日):
//   uncached 100+1000+300=1400, cacheRead 0+50000+100=50100, cacheWrite 10+100+0=110, output 40+300+80=420
const dayPeak = (json.totals.days ?? []).find((d) => d.day === dayOf(T_PEAK))
assert(dayPeak !== undefined, 'T_PEAK 当天存在逐日数据')
assert(dayPeak.tokens !== undefined && dayPeak.tokens.uncachedInput === 1400 && dayPeak.tokens.cacheRead === 50100 && dayPeak.tokens.cacheWrite === 110 && dayPeak.tokens.output === 420, 'T_PEAK 逐日 token 分桶正确, got ' + JSON.stringify(dayPeak.tokens))
// 逐日合计 = 总花费(一致性)
const dayTotal = (json.totals.days ?? []).reduce((s, d) => s + d.cost, 0)
assert(near(round6(dayTotal), json.totals.cost, 1e-6), '逐日合计与总花费一致')

// ── 预算配置 ──
assert(json.budget !== undefined && json.budget.daily === 0, '默认预算为 0(关闭), got ' + JSON.stringify(json.budget))

// ── 辅助调用计数(标题生成/网页搜索: 用量不落盘, 只能计数) ──
assert(json.totals.aux !== undefined && json.totals.aux.titles === 1 && json.totals.aux.searches === 1, '辅助调用计数 = {titles:1, searches:1}, got ' + JSON.stringify(json.totals.aux))
const dayWithAux = (json.totals.days ?? []).find((d) => d.day === dayOf(T_PEAK))
assert(dayWithAux !== undefined && dayWithAux.aux !== undefined && dayWithAux.aux.titles === 1 && dayWithAux.aux.searches === 1, '逐日辅助调用计数, got ' + JSON.stringify(dayWithAux))

// ── query 路由容错 ──
const res2 = { writeHead: () => {}, end: (b) => { res2.body = b } }
await routes.get('/balance-stats/query').handler({ method: 'GET', url: '/balance-stats/query' }, res2)
const q = JSON.parse(res2.body)
assert(q.ok === false || q.ok === true, 'query 返回合法 JSON')

console.log('✅ 全部断言通过 (v0.2.0 峰谷分层计价)')
console.log(JSON.stringify({ totals: json.totals, breakdown: json.breakdown, pricingModels: json.pricing.models }, null, 2))
