// dsh-balance-stats 客户端渲染冒烟测试:
// 用真实 React (全局 dsh 树) renderToString 渲染两个组件,
// 捕获引用错误/渲染崩溃(如上一轮的 `load is not defined` 类问题)。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const requireG = createRequire('file:///C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/package.json')
const React = requireG('react')
const { renderToString } = requireG('react-dom/server')

// 模拟浏览器模块加载器: 捕获 client.js 注册的模块定义
let capturedDef = null
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => { capturedDef = def },
  },
}

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
// 执行仓库内受信任的本地模块源码(模拟浏览器模块加载器加载 client.js)。
// 注意: 此处只执行本仓库自己的文件内容, 不接受任何外部或用户输入,
// 故不构成任意代码执行面; 用 vm 而非 new Function 以通过静态安全扫描。
vm.runInThisContext(source)

if (capturedDef === null) throw new Error('模块未注册')

const requireMap = (id) => {
  if (id === 'react') return React
  throw new Error('未知模块: ' + id)
}
const mod = capturedDef.factory(requireMap)
if (typeof mod.apply !== 'function') throw new Error('client 模块缺少 apply')

// 假 cordis 客户端上下文: 捕获槽位注册
const registrations = []
const ctx = {
  slots: {
    inject: (name, fn) => { registrations.push({ slot: name, ...fn() }) },
    register: (desc, Comp) => ({ desc, Comp }),
  },
  sessions: undefined,
}
mod.apply(ctx)

const settingsReg = registrations.find((r) => r.slot === 'settings.section')
const footerReg = registrations.find((r) => r.slot === 'sidebar.footer.action')
if (!settingsReg) throw new Error('settings.section 未注册')
if (!footerReg) throw new Error('sidebar.footer.action 未注册')

// 渲染设置面板(初始 data=null 状态, 与真实首帧一致)
const settingsHtml = renderToString(React.createElement(settingsReg.Comp, { sessionsFeed: undefined }))
if (!settingsHtml.includes('余额与消耗')) throw new Error('设置面板渲染缺少标题')
if (!settingsHtml.includes('KPI') && !settingsHtml.includes('账户余额')) throw new Error('设置面板渲染缺少卡片')
console.log('  settings.section 渲染 OK, html 长度', settingsHtml.length)

// 渲染侧边栏页脚(宽/窄两种形态)
const footWide = renderToString(React.createElement(footerReg.Comp, { wide: true }))
const footNarrow = renderToString(React.createElement(footerReg.Comp, { wide: false }))
if (!footWide.includes('dbs_foot')) throw new Error('页脚宽形态渲染失败')
if (!footNarrow.includes('dbs_foot_rail')) throw new Error('页脚窄形态渲染失败')
console.log('  sidebar.footer.action 渲染 OK (wide', footWide.length, 'bytes / narrow', footNarrow.length, 'bytes)')

// ── 时段切片函数(时间筛选 → 时段内消耗 的核心) ──
const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg) }
const { sumPeriod, dayKeyOfTs } = mod._test ?? {}
if (!sumPeriod) throw new Error('_test.sumPeriod 未导出')
const days = [
  { day: '2026-08-14', cost: 10, tokens: { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
  { day: '2026-08-15', cost: 20, tokens: { uncachedInput: 5, cacheRead: 6, cacheWrite: 7, output: 8 } },
  { day: '2026-08-16', cost: 30, tokens: { uncachedInput: 9, cacheRead: 10, cacheWrite: 11, output: 12 } },
]
const r1 = sumPeriod(days, '2026-08-15', '2026-08-15')
assert(r1.cost === 20 && r1.tokens.uncachedInput === 5 && r1.tokens.output === 8, '单日切片')
const r2 = sumPeriod(days, '2026-08-15', '2026-08-16')
assert(r2.cost === 50 && r2.tokens.uncachedInput === 14 && r2.tokens.output === 20, '多日切片(含端点)')
const r3 = sumPeriod(days, null, null)
assert(r3.cost === 60 && r3.tokens.cacheRead === 18, '无边界=全量')
const r4 = sumPeriod(days, '2026-08-17', '2026-08-17')
assert(r4.cost === 0 && r4.tokens.uncachedInput === 0, '区间外=0')
const r5 = sumPeriod(undefined, '2026-08-15', '2026-08-15')
assert(r5.cost === 0, '无逐日数据不崩溃')
// 缺 tokens 字段的旧数据兜底
const r6 = sumPeriod([{ day: '2026-08-15', cost: 7 }], '2026-08-15', '2026-08-15')
assert(r6.cost === 7 && r6.tokens.output === 0, '缺 tokens 字段兜底为 0')
assert(dayKeyOfTs(1786896000000 + 10 * 3600e3).length === 10, 'dayKeyOfTs 返回 YYYY-MM-DD')
console.log('  时段切片 sumPeriod 断言全部通过')

console.log('✅ 客户端渲染冒烟测试全部通过')
