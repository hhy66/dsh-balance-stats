/**
 * dsh-balance-stats — server half (v0.2.0)。
 *
 * 1. 余额服务: 按 refreshIntervalMs 从 DeepSeek 官方接口 `/user/balance` 拉取余额并缓存,
 *    通过 HTTP 路由 `/balance-stats/query` 提供给浏览器(浏览器只读缓存, 不打 DeepSeek)。
 *    密钥优先取配置 `apiKey`, 否则经 `ctx.credentials` 解析 `apiKeyRef`
 *    (默认 DEEPSEEK_API_KEY, 即 $DSH_HOME/.credentials.yaml 或进程环境)。
 *    接口出处: https://api-docs.deepseek.com/api/get-user-balance
 * 2. 会话消耗投影: 注册 sessionProjections 单元 `balanceConsumption`,
 *    按【事件发生时刻】的官方峰谷时段逐条计价:
 *      - 2026-08-17 00:00 (北京时间) 前: 旧价 (flash 0.02/1/2, pro 0.025/3/6)
 *      - 之后: 高峰时段(9:00-12:00 / 14:00-18:00)全价, 其余空闲时段半价
 *      计费口径与官方一致: 未命中输入(含缓存写入) × 未命中价 + 缓存命中 × 命中价 + 输出 × 输出价
 *    出处: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 3. 统计路由 `/balance-stats/stats`: 汇总本机全部会话的分层明细与预估花费,
 *    并附官方定价表与扣费规则原文, 供与官方账单逐项对账。
 */
import { z } from 'zod'

export const name = 'dsh-balance-stats'

const DEFAULT_PRICES = { cacheHit: 0.1, cacheMiss: 1, output: 2 }

/** 官方峰谷定价生效时刻: 2026-08-17T00:00:00+08:00 */
const PRICING_CUTOFF_MS = 1786896000000

/** 官方定价表(元 / 每百万 token)。出处: https://api-docs.deepseek.com/zh-cn/quick_start/pricing */
const OFFICIAL_PRICES = {
  'deepseek-v4-flash': {
    legacy: { cacheHit: 0.02, cacheMiss: 1, output: 2 },
    offpeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  },
  'deepseek-v4-pro': {
    legacy: { cacheHit: 0.025, cacheMiss: 3, output: 6 },
    offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  },
}

/** 官方说明文案(可经配置覆盖)。 */
const OFFICIAL_NOTES = {
  pricingNote: '官方说明：下表所列模型价格以「百万 tokens」为单位，根据模型输入和输出的总 token 数进行计量计费。新价格于北京时间 2026 年 8 月 17 日 00:00 起生效，采用峰谷定价：高峰时段为北京时间 9:00-12:00、14:00-18:00，空闲时段价格为高峰时段的一半。',
  billingRule: '官方扣费规则：扣减费用 = token 消耗量 × 模型单价，费用直接从充值余额或赠送余额中扣减；两者同时存在时优先扣减赠送余额。',
  pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  usageUrl: 'https://platform.deepseek.com/usage',
  balanceApiUrl: 'https://api-docs.deepseek.com/api/get-user-balance',
}

const round6 = (n) => Math.round(n * 1e6) / 1e6

/** 判断时间戳所属计费时段: legacy | peak | offpeak */
const tierOf = (timestamp) => {
  if (!Number.isFinite(timestamp) || timestamp < PRICING_CUTOFF_MS) return 'legacy'
  const d = new Date(timestamp)
  const hourBJT = (d.getUTCHours() + 8) % 24
  const isPeak = (hourBJT >= 9 && hourBJT < 12) || (hourBJT >= 14 && hourBJT < 18)
  return isPeak ? 'peak' : 'offpeak'
}

/** 指定模型 × 时段 × 计费桶的官方单价(每百万 token)。非 V4 模型用配置静态价。 */
const priceFor = (getConfig, model, tier, bucket) => {
  const cfg = getConfig()
  const table = OFFICIAL_PRICES[model]
  if (table !== undefined && table[tier] !== undefined) return table[tier][bucket]
  const staticPrices = cfg.prices?.[model] ?? cfg.defaultPrices ?? DEFAULT_PRICES
  return staticPrices[bucket] ?? DEFAULT_PRICES[bucket]
}

/** 归一化 DeepSeek 余额响应中的金额字符串。 */
const toAmount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 归一化 `/user/balance` 响应体。 */
const normalizeBalances = (data) => {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  return infos.map((info) => ({
    currency: typeof info?.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
    total: toAmount(info?.total_balance),
    granted: toAmount(info?.granted_balance),
    toppedUp: toAmount(info?.topped_up_balance),
  }))
}

const zeroBuckets = () => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
const bucketsOf = (usage) => ({
  uncachedInput: Number(usage?.inputTokens ?? 0) || 0,
  cacheRead: Number(usage?.cacheReadTokens ?? 0) || 0,
  cacheWrite: Number(usage?.cacheWriteTokens ?? 0) || 0,
  output: Number(usage?.outputTokens ?? 0) || 0,
})
const addBuckets = (a, b) => ({
  uncachedInput: a.uncachedInput + b.uncachedInput,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
})
const subBuckets = (a, b) => ({
  uncachedInput: a.uncachedInput - b.uncachedInput,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  output: a.output - b.output,
})
const bucketsEqual = (a, b) =>
  a.uncachedInput === b.uncachedInput && a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite && a.output === b.output
const bucketsEmpty = (b) => b.uncachedInput === 0 && b.cacheRead === 0 && b.cacheWrite === 0 && b.output === 0

/** 单条事件的花费: 官方计费口径(元)。 */
const costOfBuckets = (getConfig, model, tier, buckets) => {
  const miss = priceFor(getConfig, model, tier, 'cacheMiss')
  const hit = priceFor(getConfig, model, tier, 'cacheHit')
  const out = priceFor(getConfig, model, tier, 'output')
  return ((buckets.uncachedInput + buckets.cacheWrite) * miss + buckets.cacheRead * hit + buckets.output * out) / 1e6
}

/** 本地日历日 key: YYYY-MM-DD(供逐日 KPI / 预算使用)。 */
const dayKeyOf = (timestamp) => {
  const d = new Date(timestamp)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 构造会话消耗投影单元。 */
const makeConsumptionProjection = (getConfig) => {
  const emptyTiers = () => ({ legacy: zeroBuckets(), peak: zeroBuckets(), offpeak: zeroBuckets() })

  return {
    key: 'balanceConsumption',
    schema: z.object({
      models: z.array(z.string()),
      cost: z.number().nonnegative(),
      costByModel: z.record(z.string(), z.number().nonnegative()),
      tokens: z.object({
        uncachedInput: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      }).strict(),
      currency: z.string(),
      breakdown: z.array(z.object({
        model: z.string(),
        tiers: z.array(z.object({
          tier: z.enum(['legacy', 'peak', 'offpeak']),
          buckets: z.object({
            uncachedInput: z.number().int().nonnegative(),
            cacheRead: z.number().int().nonnegative(),
            cacheWrite: z.number().int().nonnegative(),
            output: z.number().int().nonnegative(),
          }).strict(),
          prices: z.object({
            cacheMiss: z.number().nonnegative(),
            cacheHit: z.number().nonnegative(),
            output: z.number().nonnegative(),
          }).strict(),
          cost: z.number().nonnegative(),
        }).strict()),
        cost: z.number().nonnegative(),
      }).strict()),
      days: z.array(z.object({
        day: z.string(),
        cost: z.number().nonnegative(),
        tokens: z.object({
          uncachedInput: z.number().int().nonnegative(),
          cacheRead: z.number().int().nonnegative(),
          cacheWrite: z.number().int().nonnegative(),
          output: z.number().int().nonnegative(),
        }).strict(),
        aux: z.object({
          titles: z.number().int().nonnegative(),
          searches: z.number().int().nonnegative(),
        }).strict().optional(),
      }).strict()),
    }).strict(),
    init: () => ({ currentModel: null, last: null, byModel: {}, modelOrder: [], byDay: {} }),
    apply: (state, event) => {
      let nextModel = state.currentModel
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        if (typeof model === 'string' && model !== '') nextModel = model
      } else if (event.type === 'request/context') {
        const model = event.data?.model
        if (typeof model === 'string' && model !== '') nextModel = model
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
        ({ turn, step } = event.data)
        usage = event.data.chunk.usage
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        ({ turn, step, usage } = event.data)
      }
      if (usage === null) {
        // 压缩摘要的 LLM 调用: 官方账单计费, 但官方 token-meter 与 dsh-balance 都不计入。
        // 它是独立计费样本(不经 agent 主循环, 无 assistant/chunk 事件), 不参与
        // (turn,step) 替换去重; 模型取事件自带 model, 回退当前请求模型。
        if (event.type === 'compaction/summary' && event.data?.usage !== undefined) {
          const rawTs2 = event.time
          const ts2 = typeof rawTs2 === 'number' ? rawTs2 : (typeof rawTs2 === 'string' ? Date.parse(rawTs2) : Date.now())
          const resolvedTs2 = Number.isFinite(ts2) ? ts2 : Date.now()
          const tier2 = tierOf(resolvedTs2)
          const day2 = dayKeyOf(resolvedTs2)
          const model2 = typeof event.data?.model === 'string' && event.data.model !== '' ? event.data.model : (state.currentModel ?? 'unknown')
          const buckets2 = bucketsOf(event.data.usage)
          if (bucketsEmpty(buckets2)) return state
          const eventCost2 = costOfBuckets(getConfig, model2, tier2, buckets2)
          const isNew2 = !(model2 in state.byModel)
          const curTiers2 = { ...(state.byModel[model2]?.tiers ?? emptyTiers()) }
          curTiers2[tier2] = addBuckets(curTiers2[tier2], buckets2)
          const byModel2 = { ...state.byModel, [model2]: { tiers: curTiers2 } }
          const byDay2 = { ...state.byDay, [day2]: { cost: round6((state.byDay[day2]?.cost ?? 0) + eventCost2), tokens: addBuckets(state.byDay[day2]?.tokens ?? zeroBuckets(), buckets2) } }
          return {
            ...state,
            byModel: byModel2,
            byDay: byDay2,
            modelOrder: isNew2 ? [...state.modelOrder, model2] : state.modelOrder,
          }
        }
        // 辅助 LLM 调用(标题生成 / 网页搜索): 官方账单计费, 但 DSH 只在会话日志里
        // 写预派发记录、从不落用量 —— 无法本地计价, 只能精确计数供对账参考。
        if (event.type === 'session/title-llm-request' || event.type === 'web/deepseek-search-llm-request') {
          const rawTs3 = event.time
          const ts3 = typeof rawTs3 === 'number' ? rawTs3 : (typeof rawTs3 === 'string' ? Date.parse(rawTs3) : Date.now())
          const resolvedTs3 = Number.isFinite(ts3) ? ts3 : Date.now()
          const day3 = dayKeyOf(resolvedTs3)
          const prevAux = state.byDay[day3]?.aux ?? { titles: 0, searches: 0 }
          const aux = event.type === 'session/title-llm-request'
            ? { ...prevAux, titles: prevAux.titles + 1 }
            : { ...prevAux, searches: prevAux.searches + 1 }
          return {
            ...state,
            byDay: { ...state.byDay, [day3]: { ...state.byDay[day3], aux } },
          }
        }
        // 与本单元无关的事件: 返回同一引用(Object.is 把关变更流)。
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const model = nextModel ?? 'unknown'
      // 事件发生时刻 → 计费时段与日历日(事件无时间戳时按当前时刻)
      const rawTs = event.time
      const ts = typeof rawTs === 'number' ? rawTs : (typeof rawTs === 'string' ? Date.parse(rawTs) : Date.now())
      const resolvedTs = Number.isFinite(ts) ? ts : Date.now()
      const tier = tierOf(resolvedTs)
      const day = dayKeyOf(resolvedTs)
      const buckets = bucketsOf(usage)
      const eventCost = costOfBuckets(getConfig, model, tier, buckets)
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
      if (previous !== null && previous.model === model && previous.tier === tier && previous.day === day && bucketsEqual(previous.buckets, buckets)) {
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const isNewModel = !(model in state.byModel)
      let byModel = state.byModel
      let byDay = state.byDay
      if (previous !== null) {
        // 同一步骤的替换样本: 先从原归属(模型×时段×日)减去旧样本, 再加新样本。
        const prevModelTiers = { ...(byModel[previous.model]?.tiers ?? emptyTiers()) }
        prevModelTiers[previous.tier] = subBuckets(prevModelTiers[previous.tier], previous.buckets)
        byModel = { ...byModel, [previous.model]: { tiers: prevModelTiers } }
        const prevDayVal = byDay[previous.day]?.cost ?? 0
        byDay = {
          ...byDay,
          [previous.day]: {
            cost: round6(prevDayVal - previous.cost),
            tokens: subBuckets(byDay[previous.day]?.tokens ?? zeroBuckets(), previous.buckets),
          },
        }
      }
      const curTiers = { ...(byModel[model]?.tiers ?? emptyTiers()) }
      curTiers[tier] = addBuckets(curTiers[tier], buckets)
      byModel = { ...byModel, [model]: { tiers: curTiers } }
      byDay = {
        ...byDay,
        [day]: {
          cost: round6((byDay[day]?.cost ?? 0) + eventCost),
          tokens: addBuckets(byDay[day]?.tokens ?? zeroBuckets(), buckets),
        },
      }
      return {
        ...state,
        currentModel: nextModel,
        last: { turn, step, model, tier, day, buckets, cost: eventCost },
        byModel,
        byDay,
        modelOrder: isNewModel ? [...state.modelOrder, model] : state.modelOrder,
      }
    },
    view: (state) => {
      const cfg = getConfig()
      const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const costByModel = {}
      const breakdown = []
      let cost = 0
      for (const model of state.modelOrder) {
        const tiersState = state.byModel[model]?.tiers ?? emptyTiers()
        const tierEntries = []
        let modelCost = 0
        for (const tier of ['legacy', 'peak', 'offpeak']) {
          const b = tiersState[tier] ?? zeroBuckets()
          if (bucketsEmpty(b)) continue
          const prices = {
            cacheMiss: priceFor(getConfig, model, tier, 'cacheMiss'),
            cacheHit: priceFor(getConfig, model, tier, 'cacheHit'),
            output: priceFor(getConfig, model, tier, 'output'),
          }
          const tierCost = round6(costOfBuckets(getConfig, model, tier, b))
          tokens.uncachedInput += b.uncachedInput
          tokens.cacheRead += b.cacheRead
          tokens.cacheWrite += b.cacheWrite
          tokens.output += b.output
          modelCost += tierCost
          tierEntries.push({ tier, buckets: b, prices, cost: tierCost })
        }
        modelCost = round6(modelCost)
        if (modelCost > 0) costByModel[model] = modelCost
        cost += modelCost
        breakdown.push({ model, tiers: tierEntries, cost: modelCost })
      }
      // 近 60 天逐日花费与 token 分桶(升序), 供 KPI 与时间筛选的时段切片使用
      const days = Object.entries(state.byDay)
        .map(([day, v]) => ({
          day,
          cost: v.cost,
          tokens: v.tokens ?? zeroBuckets(),
          ...(v.aux !== undefined ? { aux: v.aux } : {}),
        }))
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .slice(-60)
      return {
        models: state.modelOrder,
        cost: round6(cost),
        costByModel,
        tokens,
        currency: cfg.currency,
        breakdown,
        days,
      }
    },
    stateVersion: 6,
  }
}

/** 读取 HTTP POST JSON Body */
const readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1e6) {
      req.destroy()
      reject(new Error('Payload too large'))
    }
  })
  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {})
    } catch {
      reject(new Error('Invalid JSON'))
    }
  })
  req.on('error', reject)
})

const sendJson = (res, statusCode, data) => {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

const toTimestamp = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : NaN
  }
  return NaN
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const runtimeConfig = {
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
    apiKeyRef: typeof cfg.apiKeyRef === 'string' && cfg.apiKeyRef !== '' ? cfg.apiKeyRef : 'DEEPSEEK_API_KEY',
    baseUrl: typeof cfg.baseUrl === 'string' && cfg.baseUrl !== '' ? cfg.baseUrl : 'https://api.deepseek.com',
    refreshIntervalMs: typeof cfg.refreshIntervalMs === 'number' ? cfg.refreshIntervalMs : 300000,
    timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 8000,
    currency: typeof cfg.currency === 'string' && cfg.currency !== '' ? cfg.currency : 'CNY',
    warningThreshold: typeof cfg.warningThreshold === 'number' ? cfg.warningThreshold : 10,
    dangerThreshold: typeof cfg.dangerThreshold === 'number' ? cfg.dangerThreshold : 5,
    dailyBudget: typeof cfg.dailyBudget === 'number' ? cfg.dailyBudget : 0,
    prices: { ...(cfg.prices ?? {}) },
    defaultPrices: { ...(cfg.defaultPrices ?? DEFAULT_PRICES) },
    pricingNote: typeof cfg.pricingNote === 'string' && cfg.pricingNote !== '' ? cfg.pricingNote : OFFICIAL_NOTES.pricingNote,
    billingRule: typeof cfg.billingRule === 'string' && cfg.billingRule !== '' ? cfg.billingRule : OFFICIAL_NOTES.billingRule,
  }
  const getConfig = () => runtimeConfig

  /** 解析本次刷新使用的密钥(每次操作重新解析, 遵循 credentials seam)。 */
  const resolveKey = async () => {
    if (runtimeConfig.apiKey !== '') return runtimeConfig.apiKey
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(runtimeConfig.apiKeyRef)
        if (hit !== undefined) return hit.value
      } catch {
        /* 解析失败视为未配置 */
      }
    }
    return process.env[runtimeConfig.apiKeyRef] ?? ''
  }

  let cache = { state: 'empty', payload: null, error: null, fetchedAt: 0 }
  let inflight = null
  let consecutiveFailures = 0

  const refresh = () => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const key = await resolveKey()
      if (key === '') {
        cache = { state: 'error', payload: null, error: 'api-key-missing', fetchedAt: 0 }
        consecutiveFailures++
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs)
      try {
        const res = await fetch(`${runtimeConfig.baseUrl.replace(/\/+$/, '')}/user/balance`, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`DeepSeek API HTTP ${res.status}`)
        const data = await res.json()
        cache = {
          state: 'ok',
          payload: {
            isAvailable: data?.is_available === true,
            balances: normalizeBalances(data),
          },
          error: null,
          fetchedAt: Date.now(),
        }
        consecutiveFailures = 0
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        consecutiveFailures++
        if (consecutiveFailures === 1) ctx.logger.warn(`[dsh-balance-stats] balance fetch failed: ${message}`)
        // 保留上次成功值(stale-while-error), 仅标记错误。
        cache = {
          state: cache.state === 'ok' ? 'ok' : 'error',
          payload: cache.payload,
          error: message,
          fetchedAt: cache.fetchedAt,
        }
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  let loopTimer = null
  const resetLoop = () => {
    if (loopTimer !== null) {
      clearTimeout(loopTimer)
      loopTimer = null
    }
    const run = () => {
      void refresh().then(() => {
        const missingKey = cache.state === 'error' && cache.error === 'api-key-missing'
        const delay = missingKey ? 5000 : runtimeConfig.refreshIntervalMs
        loopTimer = setTimeout(run, delay)
      })
    }
    loopTimer = setTimeout(run, 1000)
  }

  ctx.effect(() => {
    resetLoop()
    return () => {
      if (loopTimer !== null) clearTimeout(loopTimer)
    }
  }, 'dsh-balance-stats: refresh loop')

  const serializeBalance = () => ({
    ok: cache.state === 'ok',
    fetchedAt: cache.fetchedAt,
    error: cache.state === 'ok' ? (cache.error ?? null) : (cache.error ?? 'unknown'),
    isAvailable: cache.state === 'ok' ? cache.payload.isAvailable : false,
    balances: cache.state === 'ok' ? cache.payload.balances : [],
    thresholds: {
      warning: runtimeConfig.warningThreshold,
      danger: runtimeConfig.dangerThreshold,
    },
    currency: runtimeConfig.currency,
    refreshIntervalMs: runtimeConfig.refreshIntervalMs,
  })

  /** 官方定价 payload(供前端展示与对账)。 */
  const serializePricing = () => ({
    effectiveAt: PRICING_CUTOFF_MS,
    source: OFFICIAL_NOTES.pricingUrl,
    usageUrl: OFFICIAL_NOTES.usageUrl,
    balanceApiUrl: OFFICIAL_NOTES.balanceApiUrl,
    note: runtimeConfig.pricingNote,
    billingRule: runtimeConfig.billingRule,
    models: {
      'deepseek-v4-flash': OFFICIAL_PRICES['deepseek-v4-flash'],
      'deepseek-v4-pro': OFFICIAL_PRICES['deepseek-v4-pro'],
    },
  })

  /** 汇总一个会话投影为行; 失败/无数据返回 null。 */
  const foldSession = (session, projections) => {
    try {
      const snap = projections.snapshot(session)
      const value = snap.values?.balanceConsumption
      if (value === undefined) return null
      const events = session.events
      let created = NaN
      let updated = NaN
      if (Array.isArray(events) && events.length > 0) {
        created = toTimestamp(events[0]?.time)
        updated = toTimestamp(events[events.length - 1]?.time)
      }
      // 标题与 Web 界面同源: 最后一个 session/title 事件
      // (LLM 生成 / 确定性回退 / 用户改名, 全部落为 session/title 事件)
      let title = ''
      const eventsArr = Array.isArray(events) ? events : []
      for (let i = eventsArr.length - 1; i >= 0; i--) {
        const ev = eventsArr[i]
        if (ev?.type === 'session/title' && typeof ev?.data?.title === 'string' && ev.data.title !== '') {
          title = ev.data.title
          break
        }
      }
      const id = typeof session.id === 'string' ? session.id : ''
      let workspace = ''
      try {
        const w = session.header?.cwd
        if (typeof w === 'string') workspace = w
      } catch {
        /* 无工作区信息 */
      }
      return {
        id,
        title,
        workspace,
        created: Number.isFinite(created) ? created : null,
        updated: Number.isFinite(updated) ? updated : null,
        tokens: value.tokens,
        cost: value.cost,
        costByModel: value.costByModel,
        models: value.models,
        breakdown: value.breakdown ?? [],
        days: value.days ?? [],
      }
    } catch {
      return null
    }
  }

  // ── 历史会话冷读: 磁盘上已持久化但未加载到内存的会话同样纳入统计 ──
  // 枚举 ctx.sessionPersistence 的元数据快照(带修订号), 对未缓存的会话
  // readFrom(id, 0) 读取完整事件日志, 用本插件的投影单元离线折叠;
  // 按 (id, revision) 缓存 —— 未加载的会话不可能再产生新事件, 缓存可长期复用。
  const cold = { status: 'idle', rows: new Map(), inFlight: null, lastScan: 0, lastError: null }

  const foldColdSession = (id, meta, eventsArr) => {
    try {
      const unit = makeConsumptionProjection(getConfig)
      let state = unit.init()
      for (const ev of eventsArr) state = unit.apply(state, ev)
      const value = unit.view(state)
      let title = ''
      for (let i = eventsArr.length - 1; i >= 0; i--) {
        const ev = eventsArr[i]
        if (ev?.type === 'session/title' && typeof ev?.data?.title === 'string' && ev.data.title !== '') {
          title = ev.data.title
          break
        }
      }
      const tokenTotal = value.tokens.uncachedInput + value.tokens.cacheRead + value.tokens.cacheWrite + value.tokens.output
      if (tokenTotal === 0 && title === '') return null // 与 Web 界面一致: 隐藏空会话
      let created = NaN
      let updated = NaN
      if (eventsArr.length > 0) {
        created = toTimestamp(eventsArr[0]?.time)
        updated = toTimestamp(eventsArr[eventsArr.length - 1]?.time)
      }
      let workspace = ''
      try {
        const w = meta?.cwd
        if (typeof w === 'string') workspace = w
      } catch {
        /* 无工作区 */
      }
      return {
        id,
        title,
        workspace,
        created: Number.isFinite(created) ? created : null,
        updated: Number.isFinite(updated) ? updated : null,
        tokens: value.tokens,
        cost: value.cost,
        costByModel: value.costByModel,
        models: value.models,
        breakdown: value.breakdown ?? [],
        days: value.days ?? [],
      }
    } catch (error) {
      ctx.logger.warn(`[dsh-balance-stats] cold fold failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const revEq = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

  const refreshCold = () => {
    if (cold.inFlight !== null) return cold.inFlight
    const now = Date.now()
    if (cold.status === 'ready' && now - cold.lastScan < 60000) return Promise.resolve()
    cold.inFlight = (async () => {
      const persistence = ctx.get('sessionPersistence')
      const store = ctx.get('sessions')
      if (persistence === undefined) {
        cold.status = 'ready'
        return
      }
      try {
        const snaps = await persistence.listSnapshots()
        const seen = new Set()
        for (const snap of snaps) {
          const id = snap?.header?.id
          if (typeof id !== 'string') continue
          seen.add(id)
          if (store?.get?.(id) !== undefined) continue // 内存会话走投影快照路径
          const cached = cold.rows.get(id)
          if (cached !== undefined && revEq(cached.revision, snap.revision)) continue
          try {
            const { meta, events } = await persistence.readFrom(id, 0)
            const row = foldColdSession(id, meta, events)
            if (row !== null) cold.rows.set(id, { row, revision: snap.revision })
            else cold.rows.delete(id)
          } catch (error) {
            ctx.logger.warn(`[dsh-balance-stats] cold read failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        for (const id of [...cold.rows.keys()]) {
          if (!seen.has(id)) cold.rows.delete(id)
        }
        cold.status = 'ready'
        cold.lastScan = Date.now()
        cold.lastError = null
      } catch (error) {
        cold.lastError = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-balance-stats] cold scan failed: ${cold.lastError}`)
      }
    })().finally(() => {
      cold.inFlight = null
    })
    return cold.inFlight
  }

  // 冷扫描延迟启动: 避开 DSH 自身的插件加载/会话恢复高峰期,
  // 让 Web 界面先起来, 历史会话在后台 2 秒后开始扫描。
  // (首次 /stats 请求若早于此触发, 会直接启动扫描并等待结果)
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void refreshCold()
    }, 2000)
    return () => {
      clearTimeout(timer)
    }
  }, 'dsh-balance-stats: delayed cold session scan')

  ctx.inject(['webServer', 'sessions', 'sessionProjections'], (c) => {
    // 1. 余额查询缓存路由
    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: '/balance-stats/query',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
          res.writeHead(405, { Allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        // 仅作 URL 解析基准(提取查询参数用), 不发起任何网络请求
        const parsedUrl = new URL(req.url ?? '/', 'http://localhost')
        const force = parsedUrl.searchParams.get('force') === '1' || parsedUrl.searchParams.get('force') === 'true' || req.method === 'POST'
        if (force) {
          // 冷却防刷保护: 距离上次主动拉取至少间隔 2000ms
          const now = Date.now()
          if (now - cache.fetchedAt > 2000 || cache.state !== 'ok') {
            await refresh()
          }
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, serializeBalance())
      },
    }), 'dsh-balance-stats: query route')

    // 2. 汇总统计路由: 余额 + 全部会话分层明细 + 官方定价
    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: '/balance-stats/stats',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const sessions = []
        const totals = {
          tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          cost: 0,
          costByModel: {},
          modelOrder: [],
          sessionCount: 0,
          workspaceCount: 0,
          currency: runtimeConfig.currency,
        }
        const workSpaces = new Set()
        let coldVisibleCount = 0
        // 跨会话合并: key = model|tier → { model, tier, buckets, prices, cost }
        const merged = new Map()
        const dayMap = new Map()
        const mergeEntry = (entry) => {
          const key = entry.model + '|' + entry.tier
          const prev = merged.get(key) ?? {
            model: entry.model,
            tier: entry.tier,
            buckets: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            prices: entry.prices,
            cost: 0,
          }
          prev.buckets = addBuckets(prev.buckets, entry.buckets)
          prev.cost = round6(prev.cost + entry.cost)
          merged.set(key, prev)
        }
        const accumulate = (row) => {
          sessions.push(row)
          totals.sessionCount++
          if (row.workspace !== '') workSpaces.add(row.workspace)
          totals.tokens.uncachedInput += row.tokens.uncachedInput
          totals.tokens.cacheRead += row.tokens.cacheRead
          totals.tokens.cacheWrite += row.tokens.cacheWrite
          totals.tokens.output += row.tokens.output
          totals.cost += row.cost
          for (const model of row.models) {
            if (!(model in totals.costByModel)) {
              totals.costByModel[model] = 0
              totals.modelOrder.push(model)
            }
            totals.costByModel[model] += row.costByModel[model] ?? 0
          }
          for (const entry of row.breakdown) {
            for (const tierEntry of entry.tiers) mergeEntry({ model: entry.model, ...tierEntry })
          }
          for (const d of row.days) {
            const prev = dayMap.get(d.day) ?? { cost: 0, tokens: zeroBuckets(), aux: { titles: 0, searches: 0 } }
            dayMap.set(d.day, {
              cost: round6(prev.cost + d.cost),
              tokens: addBuckets(prev.tokens, d.tokens ?? zeroBuckets()),
              aux: {
                titles: prev.aux.titles + (d.aux?.titles ?? 0),
                searches: prev.aux.searches + (d.aux?.searches ?? 0),
              },
            })
          }
        }
        // 历史会话冷读(带 60s 节流与修订号缓存; 首次请求会等待扫描完成)
        await refreshCold()
        try {
          for (const session of c.sessions.list()) {
            const row = foldSession(session, c.sessionProjections)
            if (row === null) continue
            accumulate(row)
          }
          // 磁盘上的历史会话(排除已在内存中的, 避免重复计数)
          let coldCount = 0
          for (const entry of cold.rows.values()) {
            const row = entry.row
            if (c.sessions.get(row.id) !== undefined) continue
            accumulate(row)
            coldCount++
          }
          coldVisibleCount = coldCount
          totals.cost = round6(totals.cost)
          totals.workspaceCount = workSpaces.size
          totals.days = [...dayMap.entries()]
            .map(([day, v]) => ({ day, cost: v.cost, tokens: v.tokens, ...(v.aux.titles > 0 || v.aux.searches > 0 ? { aux: v.aux } : {}) }))
            .sort((a, b) => (a.day < b.day ? -1 : 1))
            .slice(-60)
          totals.aux = (totals.days ?? []).reduce((acc, d) => {
            acc.titles += d.aux?.titles ?? 0
            acc.searches += d.aux?.searches ?? 0
            return acc
          }, { titles: 0, searches: 0 })
          for (const model of totals.modelOrder) {
            totals.costByModel[model] = round6(totals.costByModel[model])
          }
        } catch (error) {
          ctx.logger.warn(`[dsh-balance-stats] stats aggregation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        // 按 模型 → 时段 分组, 保持稳定顺序
        const breakdown = []
        for (const entry of merged.values()) {
          let group = breakdown.find((g) => g.model === entry.model)
          if (group === undefined) {
            group = { model: entry.model, tiers: [], cost: 0 }
            breakdown.push(group)
          }
          group.tiers.push({ tier: entry.tier, buckets: entry.buckets, prices: entry.prices, cost: entry.cost })
          group.cost = round6(group.cost + entry.cost)
        }
        const tierOrder = { legacy: 0, offpeak: 1, peak: 2 }
        for (const group of breakdown) group.tiers.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier])
        sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, {
          balance: serializeBalance(),
          totals,
          breakdown,
          pricing: serializePricing(),
          budget: { daily: runtimeConfig.dailyBudget, currency: runtimeConfig.currency },
          cold: { status: cold.status, count: coldVisibleCount, error: cold.lastError },
          sessions: sessions.slice(0, 500),
        })
      },
    }), 'dsh-balance-stats: stats route')

    // 3. 会话消耗投影注册
    c.sessionProjections.register(makeConsumptionProjection(getConfig))
  })
}
