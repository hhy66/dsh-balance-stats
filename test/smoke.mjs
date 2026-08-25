// dsh-balance-stats 宿主端冒烟测试 v0.3:
// 验证按【事件时刻】的官方峰谷计价(高峰=北京时间周一至周五 9-12/14-18, 其余半价)、
// 压缩摘要用量、冷读、逐日数据、辅助调用计数与官方定价 payload。
import { apply } from '../src/index.js'

// 时间戳(北京时间, UTC+8; Date.UTC 的月从 0 起):
//   T_PEAK    = 2026-08-18 周一 10:00 → 高峰
//   T_OFFPEAK = 2026-08-18 周一 08:00 → 空闲(工作日非高峰)
//   T_OLD     = 2026-08-16 周六 10:00 → 空闲(周末全天半价)
const T_PEAK = Date.UTC(2026, 7, 18, 2)
const T_OFFPEAK = Date.UTC(2026, 7, 18, 0)
const T_OLD = Date.UTC(2026, 7, 16, 2)

const events = [
  { time: T_PEAK, type: 'request/header', data: { header: { config: { model: 'deepseek-v4-pro' } } } },
  { time: T_PEAK, type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 120 } } } },
  { time: T_PEAK, type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 700, cacheReadTokens: 300, cacheWriteTokens: 60, outputTokens: 150 } } } }, // 同 (turn,step) 替换样本
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

// 磁盘历史会话(冷读路径): 周末, 应计为空闲价
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

// ── token 汇总 ──
assert(json.totals.sessionCount === 3, '会话数 = 3(含冷读), got ' + json.totals.sessionCount)
assert(json.totals.workspaceCount === 3, '工作区数 = 3, got ' + json.totals.workspaceCount)
assert(json.totals.tokens.uncachedInput === 2300, '未命中输入 = 2300, got ' + json.totals.tokens.uncachedInput)
assert(json.totals.tokens.cacheRead === 50450, '缓存命中 = 50450, got ' + json.totals.tokens.cacheRead)
assert(json.totals.tokens.cacheWrite === 170, '缓存写入 = 170, got ' + json.totals.tokens.cacheWrite)
assert(json.totals.tokens.output === 600, '输出 = 600, got ' + json.totals.tokens.output)

// ── 分层计价(新口径: 高峰=周一至五 9-12/14-18, 其余半价; 无旧价) ──
// pro/peak(会话A): (1700+160)×9 + 50300×0.30 + 450×27 = 43980 /1e6 = 0.04398
// flash/peak(会话A): (100+10)×3.0 + 0×0.10 + 40×9.0 = 690 /1e6 = 0.00069
// pro/offpeak(会话B+冷读): (500+0)×4.5 + 150×0.15 + 110×13.5 = 3757.5 /1e6 = 0.003758
// 合计 0.04398 + 0.00069 + 0.003758 = 0.048428
assert(near(json.totals.cost, 0.048428), '总花费 = 0.048428, got ' + json.totals.cost)

const byModel = Object.fromEntries(json.breakdown.map((g) => [g.model, g]))
assert(byModel['deepseek-v4-pro'] !== undefined && byModel['deepseek-v4-flash'] !== undefined, 'breakdown 含 pro 与 flash')
const proTiers = Object.fromEntries(byModel['deepseek-v4-pro'].tiers.map((t) => [t.tier, t]))
const flashTiers = Object.fromEntries(byModel['deepseek-v4-flash'].tiers.map((t) => [t.tier, t]))
assert(proTiers.peak && proTiers.offpeak, 'pro 有 peak+offpeak 两个时段')
assert(flashTiers.peak, 'flash 有 peak 时段')

assert(near(proTiers.peak.cost, 0.04398), 'pro peak 花费, got ' + proTiers.peak.cost)
assert(near(proTiers.peak.prices.cacheMiss, 9) && near(proTiers.peak.prices.cacheHit, 0.3) && near(proTiers.peak.prices.output, 27), 'pro peak 官方高峰价')
assert(proTiers.peak.buckets.uncachedInput === 1700 && proTiers.peak.buckets.cacheRead === 50300 && proTiers.peak.buckets.cacheWrite === 160 && proTiers.peak.buckets.output === 450, 'pro peak 分桶正确')

assert(near(proTiers.offpeak.cost, 0.003758), 'pro offpeak 花费(含周末冷读), got ' + proTiers.offpeak.cost)
assert(near(proTiers.offpeak.prices.cacheMiss, 4.5) && near(proTiers.offpeak.prices.cacheHit, 0.15) && near(proTiers.offpeak.prices.output, 13.5), 'pro offpeak 官方空闲价')
assert(proTiers.offpeak.buckets.uncachedInput === 500 && proTiers.offpeak.buckets.cacheRead === 150 && proTiers.offpeak.buckets.output === 110, 'pro offpeak 分桶(周末按空闲)')

assert(near(flashTiers.peak.cost, 0.00069), 'flash peak 花费, got ' + flashTiers.peak.cost)

// ── 官方定价 payload(含新模型, 无旧价) ──
assert(json.pricing !== null, '定价 payload 存在')
assert(json.pricing.models['deepseek-v4-pro'].peak.output === 27, 'pro 高峰输出价 27')
assert(json.pricing.models['deepseek-v4-flash-vision-exp'] !== undefined, '含新模型 vision-exp')
assert(json.pricing.models['deepseek-v4-flash-vision-exp'].peak.cacheMiss === 3.0, 'vision-exp 高峰未命中价 3.0')
assert(json.pricing.models['deepseek-v4-pro'].legacy === undefined, '旧价已移除')
assert(json.pricing.effectiveAt === undefined, 'effectiveAt 字段已移除')
assert(typeof json.pricing.note === 'string' && json.pricing.note.includes('周一至周五'), '官方说明含"周一至周五"高峰规则')

// ── 会话明细行 ──
assert(json.sessions.length === 3, '会话明细 3 行, got ' + json.sessions.length)
assert(Array.isArray(json.sessions[0].breakdown) && json.sessions[0].breakdown.length > 0, '会话行带分层明细')

// ── 冷读历史会话 ──
const coldRow = json.sessions.find((s) => s.id === 'session-old')
assert(coldRow !== undefined, '冷读会话出现在明细中')
assert(coldRow.title === '旧会话标题', '冷读会话标题取自 session/title 事件, got ' + coldRow.title)
assert(coldRow.workspace === 'D:\\old', '冷读会话工作区 = D:\\old, got ' + coldRow.workspace)
assert(near(coldRow.cost, 0.001313), '冷读会话花费 = 0.001313(周末空闲价), got ' + coldRow.cost)
assert(json.cold !== undefined && json.cold.status === 'ready' && json.cold.count === 1, 'cold 状态字段, got ' + JSON.stringify(json.cold))

// ── 标题与 Web 界面同源 ──
assert(json.sessions[0].title === '真实标题A', '标题取自 session/title 事件, got ' + JSON.stringify(json.sessions[0].title))
assert(json.sessions[0].title !== '旧的头字段(不应被采用)', 'header.title 不再被采用')

// ── 逐日花费与 token 分桶(时区无关断言) ──
const round6 = (n) => Math.round(n * 1e6) / 1e6
const dayOf = (ts) => {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const gotByDay = new Map((json.totals.days ?? []).map((d) => [d.day, d]))
// 8-18(高峰日): pro peak + flash peak + sessionB offpeak
const dPeak = gotByDay.get(dayOf(T_PEAK))
assert(dPeak !== undefined, '8-18 逐日数据存在')
assert(near(dPeak.cost, 0.047115), '8-18 花费 = 0.047115, got ' + dPeak.cost)
assert(dPeak.tokens.uncachedInput === 2100 && dPeak.tokens.cacheRead === 50400 && dPeak.tokens.cacheWrite === 170 && dPeak.tokens.output === 570, '8-18 逐日 token 分桶, got ' + JSON.stringify(dPeak.tokens))
assert(dPeak.aux !== undefined && dPeak.aux.titles === 1 && dPeak.aux.searches === 1, '8-18 辅助调用计数, got ' + JSON.stringify(dPeak.aux))
// 8-16(周末冷读日)
const dOld = gotByDay.get(dayOf(T_OLD))
assert(dOld !== undefined && near(dOld.cost, 0.001313), '8-16 冷读花费 = 0.001313, got ' + (dOld && dOld.cost))
// 逐日合计 = 总花费(一致性)
const dayTotal = (json.totals.days ?? []).reduce((s, d) => s + d.cost, 0)
assert(near(round6(dayTotal), json.totals.cost, 1e-6), '逐日合计与总花费一致')

// ── 预算与辅助调用 ──
assert(json.budget !== undefined && json.budget.daily === 0, '默认预算为 0(关闭), got ' + JSON.stringify(json.budget))
assert(json.totals.aux !== undefined && json.totals.aux.titles === 1 && json.totals.aux.searches === 1, '辅助调用计数, got ' + JSON.stringify(json.totals.aux))

// ── query 路由容错 ──
const res2 = { writeHead: () => {}, end: (b) => { res2.body = b } }
await routes.get('/balance-stats/query').handler({ method: 'GET', url: '/balance-stats/query' }, res2)
const q = JSON.parse(res2.body)
assert(q.ok === false || q.ok === true, 'query 返回合法 JSON')

console.log('✅ 全部断言通过 (v0.3 官方新定价: 工作日峰谷 + vision-exp 模型, 无旧价)')
console.log(JSON.stringify({ totals: json.totals, breakdown: json.breakdown, pricingModels: Object.keys(json.pricing.models) }, null, 2))
