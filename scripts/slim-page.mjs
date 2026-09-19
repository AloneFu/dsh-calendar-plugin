/**
 * 一次性瘦身脚本：把 standalone/calendar.html 压回 64KB 以内。
 *
 * 为什么要压：交付 gate 的 encoding-utf8 会固定切文件头 64KB 做严格 UTF-8 解码，
 * 文件一旦超过 64KB 且边界正好落在多字节字符中间，就会误报"不是合法 UTF-8"。
 * 压到 64KB 以下既满足 gate，也符合"简约"的原始要求。
 *
 * 只做**零信息损失**或**已被 README 覆盖**的删减：
 *   1. 装饰性的长横线（─/═ 连续 7 个以上）压到 6 个
 *   2. <script> 里的注释行（README 已完整记录）；保留 #region / #endregion 标记
 *   3. 连续空行压成一个
 * 全部保留：CSS 注释（逐条规则注解）、所有代码、所有字符串、region 标记。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2] || new URL('../standalone/calendar.html', import.meta.url).pathname.replace(/^\//, '')
const original = readFileSync(path, 'utf8')
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function trimRules(text) {
  return text
    .replace(/─{7,}/g, '──────')
    .replace(/═{7,}/g, '══════')
}

function stripScriptComments(script) {
  const out = []
  let inBlock = false
  for (const line of script.split('\n')) {
    if (inBlock) {
      if (/\*\//.test(line)) inBlock = false
      continue
    }
    const startBlock = /^\s*\/\*/.test(line)
    if (startBlock) {
      if (!/\*\//.test(line)) inBlock = true
      continue
    }
    // 保留 region 标记（测试与被测代码的契约）
    if (/#region|#endregion/.test(line)) { out.push(line); continue }
    if (/^\s*\/\//.test(line)) continue
    // 去掉行尾注释，但别误伤字符串里的 "http://"、"dsh-calendar://" 等
    const stripped = line.replace(/\s+\/\/(?![^\n]*['"`]).*$/, (m, offset) => {
      const before = line.slice(0, offset)
      const quotes = (before.match(/['"`]/g) || []).length
      return quotes % 2 === 1 ? m : ''
    })
    out.push(stripped.replace(/\s+$/, ''))
  }
  return out.join('\n')
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n')
}

let page = trimRules(original)
const styleMatch = /(<style>)([\s\S]*?)(<\/style>)/.exec(page)
const scriptMatch = /(<script>)([\s\S]*?)(<\/script>)/.exec(page)
if (!styleMatch || !scriptMatch) throw new Error('找不到 style/script 块')

page = page.replace(styleMatch[0], styleMatch[1] + collapseBlankLines(styleMatch[2]) + styleMatch[3])
const header = [
  '',
  '  // 文件说明：单文件零依赖月历 + Obsidian 任务/日记同步面板。',
  '  // 完整设计说明、语法表、写回护栏与验收记录见仓库里的两个 README（此处不再重复注释）。',
  '',
].join('\n')
page = page.replace(scriptMatch[0], scriptMatch[1] + header + stripScriptComments(scriptMatch[2]) + scriptMatch[3])
page = collapseBlankLines(page)

writeFileSync(path, page, 'utf8')
console.log('before:', bytes(original), 'after:', bytes(page), 'saved:', bytes(original) - bytes(page))
console.log('under 65536:', bytes(page) < 65536)
