/**
 * fit-logic.test.mjs — 面板 iframe 高度自适应的回归测试（不需要浏览器）
 *
 * 背景（实测教训）：`sidebar.right.pane.tab` 坐席把插件根元素直接放进停靠格，不保证父级是
 * "有确定高度的 flex 容器"。那种情况下 iframe 的 `height:100%` 解析成 auto → 退回 Chromium
 * 的 iframe 默认高度 **150px**，面板里只露大标题 + 星期表头，月历网格整片被裁掉（用户看到的
 * 就是"无日期"）。
 *
 * 本测试不走浏览器：直接从 lib/client.js 的 `#region 面板高度自适应` 标记块里抽源码求值，
 * 因此断言的是**真代码**而不是副本。
 *
 * 用法：node scripts/fit-logic.test.mjs [reportPath]
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const pagePath = join(here, '..', 'standalone', 'calendar.html')
const page = readFileSync(pagePath, 'utf8')

const BEGIN = '// #region 面板高度自适应'
const END = '// #endregion'
const from = source.indexOf(BEGIN)
const to = source.indexOf(END, from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能在 lib/client.js 里找到「面板高度自适应」标记块（测试与实现的契约断了）')
  process.exit(1)
}
const block = source.slice(from + BEGIN.length, to)

// 在函数作用域里求值这段真代码，取出两个被测函数
const sandbox = new Function(`${block}\n return { frameHeightFor, applyFrameHeight, MIN_FRAME_HEIGHT, USABLE_FRAME_HEIGHT }`)()
const { frameHeightFor, applyFrameHeight, MIN_FRAME_HEIGHT, USABLE_FRAME_HEIGHT } = sandbox

/* ── 桩：只需要 clientHeight / parentElement / style.height ─────────────────── */
function boxes(heights) {
  const nodes = heights.map((clientHeight) => ({ clientHeight, parentElement: null, style: { height: '' } }))
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].parentElement = nodes[i + 1]
  return nodes
}
function setup(parentHeights, frameHeight, frameInline = '') {
  const chain = boxes(parentHeights)
  const host = { parentElement: chain[0] || null, clientHeight: 0, style: { height: '' } }
  const frame = { clientHeight: frameHeight, style: { height: frameInline } }
  return { host, frame, chain }
}

const results = []
function check(name, actual, expected) {
  const ok = Object.is(actual, expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

/* 0) 契约：兜底高度必须真的放得下一个月 —— 直接对着页面 CSS 算，页面改了会让这里响 */
const dayMatch = /html\.cal-embed \.cal-day \{\s*height:\s*([\d.]+)px/.exec(page)
if (!dayMatch) {
  console.error('FAIL  无法从 standalone/calendar.html 解析 `html.cal-embed .cal-day` 的高度（页面结构变了，请同步本测试）')
  process.exit(1)
}
const embedDayHeight = Number(dayMatch[1])
// 表头栈：顶栏 44 + 大标题 40 + 选中说明 24 + 星期表头 26 + 网格上边距 2 + 卡片底部内边距 18
const HEADER_STACK = 154
const requiredHeight = HEADER_STACK + 6 * embedDayHeight
console.log(`（页面 embed 实测需求：表头栈 ${HEADER_STACK} + 6 × ${embedDayHeight} = ${requiredHeight}px）`)
check(`兜底高度 ${MIN_FRAME_HEIGHT} >= 页面实际所需 ${requiredHeight}`, MIN_FRAME_HEIGHT >= requiredHeight, true)
check('阈值低于兜底高度', USABLE_FRAME_HEIGHT < MIN_FRAME_HEIGHT, true)

/* 1) 真实 bug 现场：iframe 被压成 150，父链也没有确定高度 → 必须给兜底值，绝不能是 150 */
{
  const { host, frame } = setup([150, 0, 0], 150)
  check('bug 现场（父链全无确定高度）→ 用兜底值而非 150', frameHeightFor(host, frame), MIN_FRAME_HEIGHT)
}

/* 2) 停靠格是正常的 flex 列（高度确定）→ 撑满它 */
{
  const { host, frame } = setup([700, 900], 700)
  check('父级 700px 的确定高度 → 撑满 700', frameHeightFor(host, frame), 700)
}

/* 2b) 就近优先：最近的有确定高度的祖先胜出，不要越级量到更大的盒子 */
{
  const { host, frame } = setup([0, 640, 1200], 150)
  check('就近取第一个可用祖先（640 而非 1200）', frameHeightFor(host, frame), 640)
}

/* 3) CSS 自己已经撑满了 → 不插手（返回 0 = 清掉内联高度） */
{
  const { host, frame } = setup([0, 0], 690)
  check('CSS 已撑满 → 交回 CSS（0）', frameHeightFor(host, frame), 0)
}

/* 4) 面板开合有过渡：挂载那刻量不到，稍后量到了 → 需要能改口 */
{
  const { host, frame, chain } = setup([150, 0], 150)
  check('挂载瞬间：先兜底', frameHeightFor(host, frame), MIN_FRAME_HEIGHT)
  chain[0].clientHeight = 720
  check('面板就位后：改口撑满 720', frameHeightFor(host, frame), 720)
}

/* 5) 没有父节点（极端）也不能崩 */
{
  const host = { parentElement: null, clientHeight: 0, style: { height: '' } }
  const frame = { clientHeight: 0, style: { height: '' } }
  check('无父节点 → 兜底值（不抛异常）', frameHeightFor(host, frame), MIN_FRAME_HEIGHT)
}

/* 6) 写入行为：像素值 / 清空 / 幂等（幂等是避免 ResizeObserver 自反馈抖动的关键） */
{
  const { frame } = setup([700], 700)
  check('写入像素高度', applyFrameHeight(frame, 700), '700px')
  frame.clientHeight = 700
  check('同值重复写入不改动 style（幂等）', applyFrameHeight(frame, 700), '700px')
  check('0 → 清掉内联高度', applyFrameHeight(frame, 0), '')
  check('清空后 style.height 就是空串', frame.style.height, '')
}

const failed = results.filter((r) => !r.ok)
const report = process.argv[2]
if (report) {
  writeFileSync(report, JSON.stringify({ source: 'lib/client.js#面板高度自适应', results }, null, 2) + '\n')
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
