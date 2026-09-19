/**
 * auto-open.test.mjs — client 半边"自动打开日历 tab"的回归（不需要浏览器）
 *
 * 从 lib/client.js 的 `#region 自动打开` 标记块里抽真代码求值，
 * 断言的核心是**记账语义**：同一个会话只自动开一次 —— 你手动关掉之后不许再弹回来。
 *
 * 用法：node scripts/auto-open.test.mjs [reportPath]
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

const BEGIN = '// #region 自动打开'
const END = '// #endregion'
const from = source.indexOf(BEGIN)
const to = source.indexOf(END, from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能在 lib/client.js 里找到「自动打开」标记块（测试与实现的契约断了）')
  process.exit(1)
}
const block = source.slice(from + BEGIN.length, to)
const { createAutoOpener } = new Function(`${block}
  return { createAutoOpener }`)()

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

/* ── 记账语义 ──────────────────────────────────────────────────────────────── */
{
  const opener = createAutoOpener()
  check('第一次见到会话 → 要打开', opener.shouldOpen('s1'), true)
  check('同一个会话第二次 → 不再打开（关掉后不弹回来）', opener.shouldOpen('s1'), false)
  check('第三次依然不打开', opener.shouldOpen('s1'), false)
}
{
  const opener = createAutoOpener()
  check('两个会话各自开一次', [opener.shouldOpen('a'), opener.shouldOpen('b'), opener.shouldOpen('a'), opener.shouldOpen('b')],
    [true, true, false, false])
  check('记账条数 = 会话数', opener.count(), 2)
}
{
  const opener = createAutoOpener()
  opener.shouldOpen('x')
  opener.forget('x')
  check('forget 之后可以重试（打开失败的情形）', opener.shouldOpen('x'), true)
  check('forget 不存在的会话不炸', (() => { opener.forget('nope'); return opener.count() })() >= 1, true)
}
{
  const opener = createAutoOpener()
  check('没有会话 id 时退化成 default 键', [opener.shouldOpen(undefined), opener.shouldOpen(null), opener.shouldOpen('')],
    [true, false, false])
  check('default 只记一笔', opener.count(), 1)
}

/* ── 与实现的接线（静态检查，防止接线被改掉） ───────────────────────────────── */
check('header 按钮坐席带上了 sessionId', /inject: \(sessionId\) => \(\{ sessionId \}\)/.test(source), true)
check('组件在挂载时调用自动打开', /React\.useEffect\(\(\) => maybeAutoOpen\(sessionId\), \[sessionId\]\)/.test(source), true)
check('自动打开走 ctx.sidebarRight.openTab(KIND)', /right\.openTab\(KIND, \{\}\)/.test(source), true)
check('先问 host 开关（autoOpen === false 则跳过）', /dsh-calendar\/status/.test(source) && /data\.autoOpen !== false/.test(source), true)
check('服务未就绪会退避重试而不是放弃', /setTimeout\(\(\) => attempt\(tries - 1\), 400\)/.test(source), true)
check('彻底失败会撤销记账，留待下次', /else autoOpener\.forget\(sessionId\)/.test(source), true)
check('host 侧有这个开关（默认开）', /autoOpen: true/.test(readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')), true)

const failed = results.filter((r) => !r.ok)
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ source: 'lib/client.js#自动打开', results }, null, 2) + '\n')
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
