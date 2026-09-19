/**
 * tasks-render.test.mjs — 日历页「任务展示」逻辑 + DOM 接线的回归测试（不需要浏览器）
 *
 * 从 standalone/calendar.html 的 `#region 任务展示` 标记块里抽真代码求值，
 * 另外做两类静态耦合检查（都是不跑浏览器也能抓到的真问题）：
 *   ① 页面里 `getElementById('X')` 用到的每个 id，markup 里都必须有 id="X"
 *   ② 该块依赖的 WEEKDAY_FULL / mondayIndex 必须仍在页面里定义（防止抽取契约漂移）
 *
 * 用法：node scripts/tasks-render.test.mjs [reportPath]
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pagePath = join(here, '..', 'standalone', 'calendar.html')
const page = readFileSync(pagePath, 'utf8')

const BEGIN = '// #region 任务展示'
const END = '// #endregion'
const from = page.indexOf(BEGIN)
const to = page.indexOf(END, from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能在 calendar.html 里找到「任务展示」标记块（测试与实现的契约断了）')
  process.exit(1)
}
const block = page.slice(from + BEGIN.length, to)

// 该块的纯函数依赖两个页面级工具，这里按页面里的同名定义提供
const WEEKDAY_FULL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
const QUERY = process.env.DSHTEST_QUERY || ''
const sandbox = new Function(`
  var query = new URLSearchParams(${JSON.stringify(QUERY)})
  var WEEKDAY_FULL = ${JSON.stringify(WEEKDAY_FULL)}
  function mondayIndex(d) { return (d.getDay() + 6) % 7 }
  ${block}
  return { classifyDay, sortDayTasks, formatDayTitle, taskKind, taskMetaOf, tasksUrl, rootQuery,
    nextState, formatBytes, noteSummary, writeErrorText, MAX_DOTS, STATE_GLYPH,
    hasTime, effectiveEnd, formatDuration, timeChipLabel, clockMinutes, dayProgress,
    buildTimeline, sortScheduled, noteDotCount, formatWords, dayTooltip }`)()
const { classifyDay, sortDayTasks, formatDayTitle, taskKind, taskMetaOf, tasksUrl, rootQuery,
  nextState, formatBytes, noteSummary, writeErrorText, MAX_DOTS,
  hasTime, effectiveEnd, formatDuration, timeChipLabel, clockMinutes, dayProgress,
  buildTimeline, sortScheduled, noteDotCount, formatWords, dayTooltip } = sandbox

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

const TODAY = '2026-09-16'
const task = (over) => Object.assign({ state: 'todo', text: 'T', date: null, dateSource: null, priority: null, recurrence: null }, over)

/* ── 任务点：种类与上限 ────────────────────────────────────────────────────── */
check('无任务 → 没有点', classifyDay([], TODAY).dots, [])
check('无任务 → 计数为 0', [classifyDay([], TODAY).total, classifyDay([], TODAY).open], [0, 0])
check('普通待办 → open 点', classifyDay([task({ date: '2026-09-20' })], TODAY).dots, ['open'])
check('逾期待办 → overdue 点', classifyDay([task({ date: '2026-09-10' })], TODAY).dots, ['overdue'])
check('高优先级待办 → priority 点', classifyDay([task({ date: '2026-09-20', priority: 'high' })], TODAY).dots, ['priority'])
check('已完成 → done 点', classifyDay([task({ state: 'done' })], TODAY).dots, ['done'])
check(`一天最多 ${MAX_DOTS} 枚点`, classifyDay([1, 2, 3, 4, 5].map((n) => task({ text: 'T' + n })), TODAY).dots.length, MAX_DOTS)
check('超过上限时保留最紧急的前三枚',
  classifyDay([
    task({ text: 'a', date: '2026-09-20' }),
    task({ text: 'b', date: '2026-09-01' }),
    task({ text: 'c', priority: 'highest' }),
    task({ text: 'd', state: 'done' }),
  ], TODAY).dots,
  ['overdue', 'priority', 'open'])
check('open 计数只数未完成', classifyDay([task({}), task({ state: 'done' }), task({ state: 'cancelled' })], TODAY).open, 1)

/* ── 排序：未完成 → 完成 → 取消；未完成内部按 逾期 > 高优 > 有日期 > 无日期 ───── */
{
  const sorted = sortDayTasks([
    task({ state: 'cancelled', text: 'c' }),
    task({ state: 'done', text: 'd' }),
    task({ text: 'later', date: '2026-09-25' }),
    task({ text: 'overdue', date: '2026-09-01' }),
    task({ text: 'high', priority: 'high' }),
    task({ text: 'nodate' }),
  ], TODAY).map((t) => t.text)
  check('排序：逾期 → 高优 → 有日期 → 无日期 → 完成 → 取消', sorted, ['overdue', 'high', 'later', 'nodate', 'd', 'c'])
}
check('无优先级排在低优先级之后',
  sortDayTasks([task({ text: 'none' }), task({ text: 'low', priority: 'low' })], TODAY).map((t) => t.text),
  ['low', 'none'])
check('同优先级按正文排序', sortDayTasks([task({ text: '乙' }), task({ text: '甲' })], TODAY).map((t) => t.text), ['甲', '乙'])
check('排序不改变入参数组', (() => { const input = [task({ text: 'b' }), task({ text: 'a' })]; sortDayTasks(input, TODAY); return input.map((t) => t.text) })(), ['b', 'a'])

/* ── 表头文案 ──────────────────────────────────────────────────────────────── */
check('今天的表头带「今天 ·」前缀', formatDayTitle('2026-09-16', 3, TODAY), '今天 · 9月16日 星期三 · 3 个任务')
check('非今天不带前缀', formatDayTitle('2026-09-20', 1, TODAY), '9月20日 星期日 · 1 个任务')
check('星期计算周日正确', formatDayTitle('2026-09-27', 0, TODAY), '9月27日 星期日')
check('零任务不写个数', formatDayTitle('2026-09-20', 0, TODAY), '9月20日 星期日')

/* ── 元信息 ────────────────────────────────────────────────────────────────── */
check('优先级图标', taskMetaOf(task({ priority: 'high' }), TODAY), ['⏫'])
check('重复标记', taskMetaOf(task({ recurrence: 'every week' }), TODAY), ['🔁'])
check('⏳ 计划落点标注', taskMetaOf(task({ date: '2026-09-19', dateSource: 'scheduled' }), TODAY), ['⏳'])
check('🛫 开始落点标注', taskMetaOf(task({ date: '2026-09-19', dateSource: 'start' }), TODAY), ['🛫'])
check('📓 日记归日标注', taskMetaOf(task({ date: '2026-09-16', dateSource: 'note' }), TODAY), ['📓'])
check('due 落点不额外标注', taskMetaOf(task({ date: '2026-09-19', dateSource: 'due' }), TODAY), [])
check('逾期追加「逾期」', taskMetaOf(task({ date: '2026-09-01', dateSource: 'due' }), TODAY), ['逾期'])
check('已完成不标逾期', taskMetaOf(task({ state: 'done', date: '2026-09-01' }), TODAY), [])

/* ── 接口地址（client → host 契约，用 URLSearchParams 桩驱动） ─────────────── */
{
  const cases = [
    ['', false, '/dsh-calendar/tasks'],
    ['session=s-1', false, '/dsh-calendar/tasks?session=s-1'],
    ['session=s 1', false, '/dsh-calendar/tasks?session=s%201'],
    ['root=D%3A%5Cw', false, '/dsh-calendar/tasks?root=D%3A%5Cw'],
    ['session=s-1&root=D%3A%5Cw', true, '/dsh-calendar/tasks?session=s-1&root=D%3A%5Cw&refresh=1'],
    ['tasks=0', false, null],
    ['tasks=off&session=s-1', false, null],
  ]
  for (const [qs, refresh, expected] of cases) {
    const fn = new Function(`
      var query = new URLSearchParams(${JSON.stringify(qs)})
      ${block}
      return tasksUrl(${refresh})`)()
    check(`tasksUrl(${JSON.stringify(qs)}, refresh=${refresh})`, fn, expected)
  }
}

/* ── 写回交互的纯逻辑 ──────────────────────────────────────────────────────── */
check('点完未完成 → 目标状态 done', nextState(task({ state: 'todo' })), 'done')
check('点已完成 → 目标状态 todo', nextState(task({ state: 'done' })), 'todo')
check('取消态也能被点成完成', nextState(task({ state: 'cancelled' })), 'done')
check('空任务不炸', nextState(null), 'done')

check('字节：小于 1KB', formatBytes(512), '512 B')
check('字节：KB 一位小数', formatBytes(2048), '2.0 KB')
check('字节：MB', formatBytes(3 * 1024 * 1024), '3.0 MB')

check('没有日记 → noteSummary 为 null', noteSummary(null), null)
check('有日记 → 标题是「日记」（不露文件名）+ 体积 + 任务数',
  noteSummary({ file: '2026-09-16.md', bytes: 2048, taskCount: 3 }),
  { title: '日记', meta: '2.0 KB · 3 个任务' })
check('noteSummary 不再把文件名当标题', noteSummary({ file: '2026-09-16.md', bytes: 100, taskCount: 0 }).title === '2026-09-16.md', false)
check('没有任务数时只显示体积',
  noteSummary({ file: '2026-09-16.md', bytes: 100, taskCount: 0 }),
  { title: '日记', meta: '100 B' })

check('写回失败文案：stale 提示已被外部修改', /已被外部修改/.test(writeErrorText({ error: 'stale' })), true)
check('写回失败文案：写回关闭', /关闭/.test(writeErrorText({ error: 'write-disabled' })), true)
check('写回失败文案：越界拒绝', /拒绝写回/.test(writeErrorText({ error: 'outside-root' })), true)
check('写回失败文案：未知错误带原文', writeErrorText({ error: 'boom' }), '写回失败：boom')
check('写回失败文案：null 不炸', writeErrorText(null), '写回失败')

{
  const withSession = new Function(`
    var query = new URLSearchParams('session=s%201&root=D%3A%5Cv')
    ${block}
    return rootQuery()`)()
  check('写回查询串带上 session 与 root（与读同一来源）', withSession, '?session=s%201&root=D%3A%5Cv')
  check('无 session/root 时查询串为空', rootQuery(), '')
}

/* ── Day Planner：时间块、时长、进度、紧凑时间轴 ────────────────────────────── */
const timed = (over) => task(Object.assign({ startTime: '18:00', endTime: '18:50', startMinutes: 1080, endMinutes: 1130 }, over))

check('hasTime：有时间 / 没时间', [hasTime(timed({})), hasTime(task({})), hasTime(null)], [true, false, false])
check('effectiveEnd：写了结束时间就用它', effectiveEnd(timed({}), 30), 1130)
check('effectiveEnd：只写开始 → 补默认时长', effectiveEnd(timed({ endTime: null, endMinutes: null }), 30), 1110)
check('effectiveEnd：没时间就是 null', effectiveEnd(task({}), 30), null)
check('formatDuration：分钟', formatDuration(50), '50m')
check('formatDuration：整点', formatDuration(60), '1h')
check('formatDuration：时分', formatDuration(90), '1h30m')
check('timeChipLabel：区间', timeChipLabel(timed({})), '18:00 - 18:50')
check('timeChipLabel：单点', timeChipLabel(timed({ endTime: null, endMinutes: null })), '18:00')
check('timeChipLabel：没时间给空串', timeChipLabel(task({})), '')
check('clockMinutes 解析', [clockMinutes('18:00'), clockMinutes('9:05'), clockMinutes('坏')], [1080, 545, null])

{
  const p = dayProgress([
    task({ state: 'done' }),
    task({ state: 'done' }),
    task({ state: 'todo' }),
    timed({ state: 'todo' })
  ])
  check('当天进度：完成数/总数/百分比', [p.done, p.total, p.pct], [2, 4, 50])
  check('当天进度：已排时间计数', p.scheduled, 1)
  check('空一天的进度不炸', dayProgress([]), { total: 0, done: 0, open: 0, scheduled: 0, pct: 0 })
}

{
  const a = timed({ text: 'A', startMinutes: 1080, endMinutes: 1130 })
  const b = timed({ text: 'B', startMinutes: 1210, endMinutes: 1230, startTime: '20:10', endTime: '20:30' })
  const built = buildTimeline([a, b], { defaultDurationMinutes: 30, nowMinutes: null })
  const hourRows = built.rows.filter((r) => r.type === 'hour')
  // 每个任务各往外扩一小时：A(18:00-18:50)→17..20，B(20:10-20:30)→19..22，合起来 17..22
  check('时间轴：小时行覆盖任务时刻±1', hourRows.map((r) => r.hour), [17, 18, 19, 20, 21, 22])
  check('时间轴：任务落在自己的小时行', hourRows.filter((r) => r.tasks.length > 0).map((r) => r.tasks[0].text), ['A', 'B'])
  check('时间轴：连续小时不产生折叠行', built.rows.filter((r) => r.type === 'gap').length, 0)
  check('时间轴：小时标签格式', hourRows[1].label, '18:00')
}
{
  // 隔得够远（≥4 小时）才会出现折叠行：A(8:00-8:50)→7..10，B(14:00-14:30)→13..16
  const a = timed({ text: '晨跑', startMinutes: 480, endMinutes: 530, startTime: '08:00', endTime: '08:50' })
  const b = timed({ text: '开会', startMinutes: 840, endMinutes: 870, startTime: '14:00', endTime: '14:30' })
  const built = buildTimeline([a, b], { defaultDurationMinutes: 30, nowMinutes: null })
  const gaps = built.rows.filter((r) => r.type === 'gap')
  check('时间轴：中段空白折叠成一条', gaps.length, 1)
  check('时间轴：折叠行区间与文案', [gaps[0].from, gaps[0].to, gaps[0].label], [10, 13, '10:00'])
  check('时间轴：折叠不吞掉有安排的小时',
    built.rows.filter((r) => r.type === 'hour').map((r) => r.hour), [7, 8, 9, 10, 13, 14, 15, 16])
}
{
  const built = buildTimeline([timed({})], { defaultDurationMinutes: 30, nowMinutes: 1085 })
  const row = built.rows.find((r) => r.type === 'hour' && r.hour === 18)
  check('时间轴：现在指示线的位置（18:05 → 约 8.3%）', Math.round(row.nowOffsetPct), 8)
  check('时间轴：now 汇总也带出来', built.now, { hour: 18, offsetPct: (1085 % 60) / 60 * 100 })
}
check('时间轴：一天没安排且不看现在 → 没有行', buildTimeline([], { nowMinutes: null }).rows, [])
check('时间轴：没有安排但今天是 18:05 → 只画现在前后', 
  buildTimeline([], { nowMinutes: 1085 }).rows.map((r) => r.hour), [17, 18, 19])
check('时间轴：按开始时间排序', sortScheduled([timed({ text: '晚', startMinutes: 1200 }), timed({ text: '早', startMinutes: 600 })]).map((t) => t.text), ['早', '晚'])

/* ── Calendar 插件：字数点 ─────────────────────────────────────────────────── */
check('noteDotCount：没有日记 → 0 枚', noteDotCount(null, 250, 2), 0)
check('noteDotCount：空日记 → 0 枚', noteDotCount({ words: 0 }, 250, 2), 0)
check('noteDotCount：不到一格也给 1 枚', noteDotCount({ words: 42 }, 250, 2), 1)
check('noteDotCount：满一格 → 1 枚', noteDotCount({ words: 250 }, 250, 2), 1)
check('noteDotCount：两格 → 2 枚', noteDotCount({ words: 600 }, 250, 2), 2)
check('noteDotCount：受上限约束', noteDotCount({ words: 9999 }, 250, 2), 2)
check('noteDotCount：wordsPerDot 可配', noteDotCount({ words: 100 }, 50, 3), 2)
check('formatWords：小数目', formatWords(820), '820 词')
check('formatWords：上千折成 k', formatWords(1240), '1.2k 词')
check('formatWords：整千不带小数', formatWords(2000), '2k 词')
check('dayTooltip：没写日记时会说明', /还没写日记/.test(dayTooltip('2026-09-19', [], TODAY, null)), true)
check('dayTooltip：写了日记带字数', /已写 820 词/.test(dayTooltip('2026-09-19', [], TODAY, { words: 820 })), true)
check('dayTooltip：有任务时带完成比', /1\/2 个任务完成/.test(dayTooltip('2026-09-19', [task({ state: 'done' }), task({})], TODAY, null)), true)

/* ── 静态耦合检查（不跑浏览器也能抓到的接线错误） ───────────────────────────── */
{
  const ids = [...new Set([...page.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))].sort()
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(page))
  check(`getElementById 用到的 ${ids.length} 个 id 都在 markup 里`, missing, [])
}
check('页面仍定义 WEEKDAY_FULL', /var WEEKDAY_FULL = \[/.test(page), true)
check('页面仍定义 mondayIndex', /function mondayIndex\(/.test(page), true)
check('月历格渲染任务点', /dots\.className = 'cal-dots'/.test(page), true)
check('任务正文用 textContent（不拼 HTML）', /createTextNode/.test(page) && !/calTaskList\.innerHTML/.test(page), true)
check('任务状态字形是可点按钮（写回入口）', /glyph\.className = 'cal-task-state/.test(page) && /toggleTask\(task\)/.test(page), true)
check('写回请求带自定义头（挡跨站误触）', /'x-dsh-calendar': 'write'/.test(page), true)
check('写回前带 expect（乐观并发凭据）', /expect: task\.raw/.test(page), true)
check('有轮询让 Obsidian 改动自动跟上', /setInterval\(/.test(page) && /15000/.test(page), true)
check('新建日记按钮已接线', /els\.noteNew\.addEventListener\('click', createNoteForSelected\)/.test(page), true)

/* ── 本轮新增：任务可编辑 / 渐变背景 / 点击波纹 / 不显示文件名 ──────────────── */
check('任务正文可点即改（进入就地编辑）', /beginEdit\(task, text, li\)/.test(page) && /text\.classList\.add\('is-editable'\)/.test(page), true)
check('编辑走独立写回路由 /tasks/update', /postWrite\('\/dsh-calendar\/tasks\/update'/.test(page), true)
check('回车提交 / Esc 取消 / 编辑时不吃方向键',
  /event\.key === 'Enter'/.test(page) && /event\.key === 'Escape'/.test(page) && /event\.stopPropagation\(\)/.test(page), true)
check('失焦也提交（避免"改了没生效"）', /input\.addEventListener\('blur', commit\)/.test(page), true)
check('任务行不再显示文件名（只留在 data 属性）',
  !/li\.title = task\.file/.test(page) && /li\.dataset\.file = task\.file/.test(page), true)
check('新建日记成功不再弹「已创建…」（成功分支把 notice 清空）',
  /if \(!result \|\| result\.ok !== true\)[\s\S]{0,240}?\}\s*else \{\s*TASKS\.notice = ''/.test(page), true)
check('背景是渐变（页面 + 卡片两处 linear-gradient）',
  /body \{[\s\S]*?linear-gradient\(180deg, var\(--cal-page/.test(page) &&
  /\.cal \{[\s\S]*?linear-gradient\(180deg, var\(--cal-card/.test(page), true)
check('内嵌面板也叠一层柔和渐变（--cal-wash）', /linear-gradient\(180deg, var\(--cal-wash\)/.test(page), true)
check('点击波纹：样式 + 生成函数 + 捕获阶段委托',
  /\.cal-ripple \{/.test(page) && /function spawnRipple\(/.test(page) &&
  /closest\('\.cal-rippleable'\)/.test(page) && /}, true\)/.test(page), true)
check('波纹尊重"减少动态效果"', /prefers-reduced-motion: reduce[\s\S]{0,120}\.cal-ripple \{ display: none/.test(page), true)
check('日/格/按钮都挂了波纹宿主类',
  (page.match(/cal-rippleable/g) || []).length >= 8, true)

/* ── Day Planner / Calendar 适配的接线 ─────────────────────────────────────── */
check('进度条元素与填充、文案都已接线',
  /id="calProgress"/.test(page) && /id="calProgressFill"/.test(page) && /progressFill\.style\.width/.test(page), true)
check('时间轴容器存在且渲染器已接线',
  /id="calTimeline"/.test(page) && /function renderTimeline\(/.test(page) && /buildTimeline\(scheduled/.test(page), true)
check('时间胶囊可点改时间（走 /tasks/schedule）',
  /cal-time-chip/.test(page) && /beginTimeEdit\(task, chip, li\)/.test(page) && /'\/dsh-calendar\/tasks\/schedule'/.test(page), true)
check('时间编辑器有保存/清除/取消，且回车提交、Esc 取消',
  /save\.textContent = '✓'/.test(page) && /clear\.textContent = '清除'/.test(page) &&
  /cancel\.textContent = '✕'/.test(page) && /event\.key === 'Escape'/.test(page), true)
check('新建待办表单（文本 + 时间 + 添加）已接线',
  /id="calAddText"/.test(page) && /id="calAddTime"/.test(page) &&
  /els\.add\.addEventListener\('submit'/.test(page) && /'\/dsh-calendar\/tasks\/add'/.test(page), true)
check('月历格同时画日记字数点与任务点',
  /cal-dot is-note/.test(page) && /fillDots\(dots, dayTasks, todayKey, dayNote\)/.test(page), true)
check('日期格有悬停说明（字数 + 任务情况）', /cell\.title = dayTooltip\(/.test(page), true)
check('未安排分组标题存在', /cal-group-title/.test(page) && /'未安排'/.test(page), true)
check('时间轴/进度/新建的样式齐备',
  /\.cal-timeline \{/.test(page) && /\.cal-now \{/.test(page) && /\.cal-hour-label \{/.test(page) &&
  /\.cal-add-text \{/.test(page), true)

/* ── 体积守卫：交付 gate 会固定切文件头 64KB 做严格 UTF-8 解码 ────────────────
 * 页面一旦超过 65536 字节，且边界正好落在多字节字符（中文/emoji/框线）中间，
 * 就会被判成"不是合法 UTF-8"。所以这里把上限钉死在 64KB 并留出余量。
 * 需要瘦身时跑 `node scripts/slim-page.mjs`（做零信息损失的删减）。 */
{
  const pageBytes = Buffer.byteLength(page, 'utf8')
  check(`页面体积 < 65536 字节（当前 ${pageBytes}，余量 ${65536 - pageBytes}）`, pageBytes < 65536, true)
  let wholeOk = true
  let headOk = true
  const buf = Buffer.from(page, 'utf8')
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { wholeOk = false }
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 65536)) } catch { headOk = false }
  check('整篇是合法 UTF-8', wholeOk, true)
  check('文件头 64KB 切片也是合法 UTF-8（gate 的切法）', headOk, true)
}
{
  // 内联脚本语法可编译（编译不执行）：改坏了至少能在没有浏览器时抓到语法错误
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)
  let compileError = null
  try {
    if (!script) throw new Error('页面里找不到 <script> 块')
    new Function(script[1])
  } catch (error) {
    compileError = String(error.message)
  }
  check('页面内联脚本语法可编译', compileError, null)
}

const failed = results.filter((r) => !r.ok)
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ source: 'calendar.html#任务展示', results }, null, 2) + '\n')
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
