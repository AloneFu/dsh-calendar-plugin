/**
 * tasks-parse.test.mjs — Obsidian Tasks 行解析的回归测试（不需要浏览器）
 *
 * 直接从 lib/index.js 的 `#region Obsidian Tasks 解析` 标记块里抽源码求值，
 * 断言的是**真代码**而不是副本。
 *
 * 用法：node scripts/tasks-parse.test.mjs [reportPath]
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

const BEGIN = '// #region Obsidian Tasks 解析'
const END = '// #endregion'
const from = source.indexOf(BEGIN)
const to = source.indexOf(END, from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能在 lib/index.js 里找到「Obsidian Tasks 解析」标记块（测试与实现的契约断了）')
  process.exit(1)
}
const WRITE_BEGIN = '// #region 任务写回与日记'
const writeFrom = source.indexOf(WRITE_BEGIN)
const writeTo = source.indexOf(END, writeFrom)
if (writeFrom < 0 || writeTo < 0) {
  console.error('FAIL  未能在 lib/index.js 里找到「任务写回与日记」标记块（测试与实现的契约断了）')
  process.exit(1)
}
const block = source.slice(from + BEGIN.length, to) + '\n' + source.slice(writeFrom + WRITE_BEGIN.length, writeTo)
const sandbox = new Function(`${block}
  return { parseTaskLine, parseTasksInMarkdown, groupByDate, cleanText, isIsoDate,
    dateKeyFromBasename, rewriteTaskLine, rewriteTaskDescription, noteExcerpt, noteTitleFor, humanDate,
    clockToMinutes, minutesToClock, parseTimePrefix, rewriteTaskTime, countWords }`)()
const {
  parseTaskLine, parseTasksInMarkdown, groupByDate, cleanText, isIsoDate,
  dateKeyFromBasename, rewriteTaskLine, rewriteTaskDescription, noteExcerpt, noteTitleFor, humanDate,
  clockToMinutes, minutesToClock, parseTimePrefix, rewriteTaskTime, countWords,
} = sandbox

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

/* ── 状态 ───────────────────────────────────────────────────────────────────── */
check('[ ] → todo', parseTaskLine('- [ ] 待办', 'a.md', 1).state, 'todo')
check('[x] → done', parseTaskLine('- [x] 完成', 'a.md', 2).state, 'done')
check('[X] → done（大写同样认）', parseTaskLine('* [X] 完成', 'a.md', 3).state, 'done')
check('[-] → cancelled', parseTaskLine('+ [-] 取消', 'a.md', 4).state, 'cancelled')
check('缩进的任务也认', parseTaskLine('    - [ ] 子任务', 'a.md', 5).state, 'todo')

/* ── 日期三件套与展示落点 ──────────────────────────────────────────────────── */
{
  const t = parseTaskLine('- [ ] 三日期 📅 2026-09-20 ⏳ 2026-09-18 🛫 2026-09-10', 'a.md', 6)
  check('📅 due', t.due, '2026-09-20')
  check('⏳ scheduled', t.scheduled, '2026-09-18')
  check('🛫 start', t.start, '2026-09-10')
  check('落点优先 due', [t.date, t.dateSource], ['2026-09-20', 'due'])
}
{
  const t = parseTaskLine('- [ ] 只有计划 ⏳ 2026-09-19', 'a.md', 7)
  check('无 due 时落点 scheduled', [t.date, t.dateSource], ['2026-09-19', 'scheduled'])
}
{
  const t = parseTaskLine('- [ ] 只有开始 🛫 2026-09-23', 'a.md', 8)
  check('无 due/scheduled 时落点 start', [t.date, t.dateSource], ['2026-09-23', 'start'])
}
check('无日期 → 不入月历', [parseTaskLine('- [ ] 随手记', 'a.md', 9).date, parseTaskLine('- [ ] 随手记', 'a.md', 9).dateSource], [null, null])

/* ── 其它元数据 ─────────────────────────────────────────────────────────────── */
{
  const t = parseTaskLine('- [x] 干完了 ✅ 2026-09-15 ➕ 2026-09-01', 'a.md', 10)
  check('✅ done 日期', t.done, '2026-09-15')
  check('➕ created 日期', t.created, '2026-09-01')
}
check('❌ cancelled 日期', parseTaskLine('- [-] 算了 ❌ 2026-09-16', 'a.md', 11).cancelled, '2026-09-16')
check('🔁 重复规则', parseTaskLine('- [ ] 每周复盘 🔁 every week 📅 2026-09-21', 'a.md', 12).recurrence, 'every week')

/* ── 优先级（Obsidian Tasks 五档） ─────────────────────────────────────────── */
for (const [glyph, level] of [['🔺', 'highest'], ['⏫', 'high'], ['🔼', 'medium'], ['🔽', 'low'], ['⏬', 'lowest']]) {
  check(`${glyph} → ${level}`, parseTaskLine(`- [ ] 任务 ${glyph}`, 'a.md', 13).priority, level)
}
check('无优先级 → null', parseTaskLine('- [ ] 任务', 'a.md', 14).priority, null)

/* ── 标签与正文清洗 ────────────────────────────────────────────────────────── */
{
  const t = parseTaskLine('- [ ] 买咖啡豆 ➕ 2026-09-10 📅 2026-09-17 #life #购物', 'a.md', 15)
  check('标签提取', t.tags, ['#life', '#购物'])
  check('正文不含日期/优先级/重复元数据', t.text, '买咖啡豆 #life #购物')
}
check('正文保留普通文字与标点', cleanText('写《设计心理学》读书笔记 📅 2026-09-20'), '写《设计心理学》读书笔记')
check('正文保留行内标签', cleanText('复盘 #work'), '复盘 #work')
check('🔁 规则整段从正文里去掉（不留残字）', cleanText('每周复盘 🔁 every week 📅 2026-09-21'), '每周复盘')
check('🔁 在正文中间也整段去掉', cleanText('复盘 🔁 every month when done ⏫ 收尾'), '复盘 收尾')
check('多字段混合清洗', cleanText('买咖啡豆 ➕ 2026-09-10 📅 2026-09-17 🔼 #life'), '买咖啡豆 #life')
{
  const t = parseTaskLine('- [ ] 每周复盘 🔁 every week 📅 2026-09-21', 'a.md', 15)
  check('重复任务的正文与规则都解析正确', [t.text, t.recurrence, t.due], ['每周复盘', 'every week', '2026-09-21'])
}

/* ── 非法输入 ──────────────────────────────────────────────────────────────── */
check('月不合法 → 不认这个日期', parseTaskLine('- [ ] 坏日期 📅 2026-13-01', 'a.md', 16).due, null)
check('日不合法 → 不认这个日期', parseTaskLine('- [ ] 坏日期 📅 2026-09-45', 'a.md', 17).due, null)
check('isIsoDate 边界：2026-02-30 视作合法格式', isIsoDate('2026-02-30'), true)
check('isIsoDate 拒绝非日期', isIsoDate('2026-9-1'), false)
check('普通列表不是任务', parseTaskLine('- 普通条目 📅 2026-09-16', 'a.md', 18), null)
check('有序列表不是任务', parseTaskLine('1. 有序条目', 'a.md', 19), null)
check('标题不是任务', parseTaskLine('# 标题', 'a.md', 20), null)
check('空正文也是任务', parseTaskLine('- [ ] ', 'a.md', 21).text, '')

/* ── 文件级：围栏代码块必须跳过 ────────────────────────────────────────────── */
{
  const md = [
    '- [ ] 真任务 📅 2026-09-16',
    '```md',
    '- [ ] 代码块里的假任务 📅 2026-09-16',
    '```',
    '- [ ] 又一个真任务 📅 2026-09-17',
  ].join('\n')
  const tasks = parseTasksInMarkdown(md, 'x.md')
  check('围栏内的伪任务被跳过', tasks.length, 2)
  check('行号仍指向原文', tasks.map((t) => t.line), [1, 5])
  check('文件字段写进结果', tasks[0].file, 'x.md')
}
{
  const tasks = parseTasksInMarkdown('- [ ] A 📅 2026-09-16\n- [ ] B ⏳ 2026-09-16\n- [ ] C\n', 'y.md')
  const { buckets, undated } = groupByDate(tasks)
  check('同一天聚成一桶', buckets['2026-09-16'].length, 2)
  check('未排期单独计数', undated, 1)
}

/* ── 日记归日：日记里没写日期的待办算作那一天（宿主扫描时打戳） ─────────────── */
{
  // 与 lib/index.js scanTasks 里的打戳规则保持一致：仅当任务没有显式日期时，才用日记日期
  const stamp = (source, file) => {
    const noteDate = dateKeyFromBasename(file.replace(/\.md$/i, ''))
    const tasks = parseTasksInMarkdown(source, file)
    for (const t of tasks) if (!t.date && noteDate) { t.date = noteDate; t.dateSource = 'note' }
    return tasks
  }
  const tasks = stamp('# 2026-09-16 星期三\n- [ ] 回寝室睡觉\n- [ ] 带日期 📅 2026-09-20\n- [ ] 计划 ⏳ 2026-09-18\n', '2026-09-16.md')
  check('日记里无日期的待办 → 算作日记那天', [tasks[0].date, tasks[0].dateSource], ['2026-09-16', 'note'])
  check('显式 📅 不被日记日期覆盖', [tasks[1].date, tasks[1].dateSource], ['2026-09-20', 'due'])
  check('显式 ⏳ 不被覆盖', [tasks[2].date, tasks[2].dateSource], ['2026-09-18', 'scheduled'])
  const { buckets, undated } = groupByDate(tasks)
  check('日记里的待办进入当天桶', buckets['2026-09-16'].length, 1)
  check('日记归日后没有未排期', undated, 0)
  const plain = stamp('- [ ] 随手记\n', '会议记录.md')
  check('非日记文件仍然不进月历', [plain[0].date, plain[0].dateSource], [null, null])
}

/* ── 写回：整行改写（安全关键，逐字符断言） ─────────────────────────────────── */
const DAY = '2026-09-16'
const rewrite = (line, done, appendDoneDate) => rewriteTaskLine(line, { done, date: DAY, appendDoneDate })

check('勾选完成：加 [x] 并追加 ✅ 日期', rewrite('- [ ] 写发布说明 #docs', true, true), '- [x] 写发布说明 #docs ✅ 2026-09-16')
check('取消完成：回到 [ ] 并移除 ✅ 日期', rewrite('- [x] 写发布说明 #docs ✅ 2026-09-10', false, true), '- [ ] 写发布说明 #docs')
check('已有 ✅ 时只更新日期，不重复追加', rewrite('- [x] 收尾 ✅ 2026-09-01', true, true), '- [x] 收尾 ✅ 2026-09-16')
check('缩进 + * 项目符号 + 优先级 + 多标签原样保留',
  rewrite('    * [ ] 周会材料 ⏫ #work #dsh', true, true),
  '    * [x] 周会材料 ⏫ #work #dsh ✅ 2026-09-16')
check('due 日期与其它元数据不受影响',
  rewrite('- [ ] 交付 📅 2026-09-20 ⏳ 2026-09-18', true, true),
  '- [x] 交付 📅 2026-09-20 ⏳ 2026-09-18 ✅ 2026-09-16')
check('取消态 [-] 也能标完成', rewrite('- [-] 迁移数据', true, true), '- [x] 迁移数据 ✅ 2026-09-16')
check('空正文也能标完成', rewrite('- [ ]', true, true), '- [x] ✅ 2026-09-16')
check('✅ 前后多余空格会被规范化', rewrite('- [x] 收尾  ✅  2026-09-01', true, true), '- [x] 收尾 ✅ 2026-09-16')
check('关掉 appendDoneDate：只翻勾选框（完成）', rewrite('- [ ] 只翻框', true, false), '- [x] 只翻框')
check('关掉 appendDoneDate：取消完成也不动 ✅', rewrite('- [x] 只翻框 ✅ 2026-09-10', false, false), '- [ ] 只翻框 ✅ 2026-09-10')
check('幂等：已是完成再标完成，结果不变', rewrite(rewrite('- [ ] x', true, true), true, true), '- [x] x ✅ 2026-09-16')
check('来回切一圈回到原样', rewrite(rewrite('- [ ] x ⏫ #t', true, true), false, true), '- [ ] x ⏫ #t')
check('非任务行拒绝改写（返回 null）', rewrite('- 普通条目', true, true), null)
check('标题行拒绝改写', rewrite('## 标题', true, true), null)
check('写回后能被解析器读回（闭环）', parseTaskLine(rewrite('- [ ] 闭环 📅 2026-09-16', true, true), 'a.md', 1).done, DAY)
check('写回后状态读回是 done', parseTaskLine(rewrite('- [ ] 闭环', true, true), 'a.md', 1).state, 'done')

/* ── 日记：文件名日期识别 ──────────────────────────────────────────────────── */
check('2026-09-16 → 日记日期', dateKeyFromBasename('2026-09-16'), '2026-09-16')
check('带后缀的文件名也认', dateKeyFromBasename('2026-09-16 星期三'), '2026-09-16')
check('点分隔', dateKeyFromBasename('2026.9.6'), '2026-09-06')
check('中文式', dateKeyFromBasename('2026年9月16日'), '2026-09-16')
check('紧凑 8 位', dateKeyFromBasename('20260916'), '2026-09-16')
check('非法月 → null', dateKeyFromBasename('2026-13-01'), null)
check('不是日期的名字 → null', dateKeyFromBasename('会议记录'), null)
check('空名 → null', dateKeyFromBasename(''), null)

/* ── 日记：标题与摘要 ──────────────────────────────────────────────────────── */
check('默认标题模板', noteTitleFor('2026-09-16', undefined), '# 2026-09-16 星期三')
check('{human} 占位符', noteTitleFor('2026-09-16', '{human}'), '2026年9月16日 星期三')
check('humanDate 星期正确（2026-09-20 是星期日）', humanDate('2026-09-20'), '2026年9月20日 星期日')
{
  const source = [
    '---',
    'tags: [daily]',
    '---',
    '# 2026-09-16 星期三',
    '',
    '今天把日历插件接上了 Obsidian。',
    '- [ ] 提交交付 📅 2026-09-16',
    '继续写两句。',
    '```',
    '代码块里的字不该进摘要',
    '```',
  ].join('\n')
  const excerpt = noteExcerpt(source, 800)
  check('摘要去掉 frontmatter', excerpt.includes('tags: [daily]'), false)
  check('摘要去掉任务行', excerpt.includes('提交交付'), false)
  check('摘要去掉围栏代码块', excerpt.includes('代码块里的字'), false)
  check('摘要保留正文（含换行）', excerpt.includes('今天把日历插件接上了 Obsidian。') && excerpt.includes('继续写两句。'), true)
  check('摘要去掉标题的 # 记号', /^2026-09-16 星期三/m.test(excerpt), true)
}
check('超长摘要截断并加省略号', noteExcerpt('a'.repeat(50), 20), 'a'.repeat(20) + '…')

/* ── 改描述：只换正文，勾选与元数据尾巴一字不动 ────────────────────────────── */
const edit = (line, text) => rewriteTaskDescription(line, text)
check('改描述：无元数据', edit('- [ ] 旧内容', '新内容'), '- [ ] 新内容')
check('改描述：保留完成态', edit('- [x] 旧内容 ✅ 2026-09-16', '新内容'), '- [x] 新内容 ✅ 2026-09-16')
check('改描述：保留 📅⏳ 与优先级',
  edit('- [ ] 旧内容 📅 2026-09-20 ⏳ 2026-09-18 ⏫', '新内容'),
  '- [ ] 新内容 📅 2026-09-20 ⏳ 2026-09-18 ⏫')
check('改描述：保留缩进与 * 项目符号',
  edit('    * [ ] 旧内容 ⏫ #work', '新内容'),
  '    * [x] 新内容 ⏫ #work'.replace('[x]', '[ ]'))
check('改描述：标签留在正文里（用户自己写的）',
  edit('- [ ] 旧 #tag', '新 #tag2'),
  '- [ ] 新 #tag2')
check('改描述：元数据夹在正文中间也不丢字符',
  edit('- [ ] 前段 📅 2026-09-20 后段', '替换'),
  '- [ ] 替换 📅 2026-09-20 后段')
check('改描述：取消态保留', edit('- [-] 旧', '新'), '- [-] 新')
check('改描述：换行被压成空格', edit('- [ ] 旧', '一\n二'), '- [ ] 一 二')
check('改描述：多余空白被压掉', edit('- [ ] 旧', '  新   内容  '), '- [ ] 新 内容')
check('改描述：非任务行拒绝', edit('## 标题', '新'), null)
check('改描述：改完仍可被解析器读回', parseTaskLine(edit('- [ ] 旧 📅 2026-09-16 ⏫', '新'), 'a.md', 1).priority, 'high')

/* ── Day Planner 时间头：`HH:mm - HH:mm` / 单点 `HH:mm` ─────────────────────── */
check('clockToMinutes 正常', clockToMinutes('18:00'), 1080)
check('clockToMinutes 带前导零/无前导零都认', [clockToMinutes('09:05'), clockToMinutes('9:05')], [545, 545])
check('clockToMinutes 非法小时', clockToMinutes('25:00'), null)
check('clockToMinutes 非法分钟', clockToMinutes('18:60'), null)
check('minutesToClock 回落日', [minutesToClock(1080), minutesToClock(0), minutesToClock(1439)], ['18:00', '00:00', '23:59'])
check('时间往返不丢', minutesToClock(clockToMinutes('07:05')), '07:05')
{
  const t = parseTaskLine('- [ ] 18:00 - 18:50 吃饭', 'a.md', 1)
  check('时间块：开始/结束/时长', [t.startTime, t.endTime, t.durationMinutes], ['18:00', '18:50', 50])
  check('时间块：分钟数', [t.startMinutes, t.endMinutes], [1080, 1130])
  check('时间块：正文不含时间', t.text, '吃饭')
  check('时间块：原文时间头留档', t.timeText, '18:00 - 18:50')
}
{
  const t = parseTaskLine('- [ ] 9:05 起床', 'a.md', 2)
  check('单点时间：只有开始', [t.startTime, t.endTime], ['09:05', null])
  check('单点时间：正文不含时间', t.text, '起床')
}
{
  const t = parseTaskLine('- [ ] 吃饭 18:00', 'a.md', 3)
  check('时间不在行首 → 不当时间头', [t.startTime, t.text], [null, '吃饭 18:00'])
}
check('非法时间 → 不当时间头', parseTaskLine('- [ ] 25:00 睡觉', 'a.md', 4).startTime, null)
{
  const t = parseTaskLine('- [ ] 18:00 - 18:50 吃饭 📅 2026-09-19 ⏫ #work', 'a.md', 5)
  check('时间 + 元数据可以共存', [t.startTime, t.endTime, t.due, t.priority, t.text], ['18:00', '18:50', '2026-09-19', 'high', '吃饭 #work'])
}
check('不同连接号也认（含波浪号）', parseTaskLine('- [ ] 18:00~19:00 连号', 'a.md', 6).endTime, '19:00')
check('破折号（–）也认', parseTaskLine('- [ ] 18:00 – 19:00 破折', 'a.md', 7).endTime, '19:00')
check('只有时间没正文也认', parseTaskLine('- [ ] 18:00', 'a.md', 8).startTime, '18:00')

/* ── 改描述不能动时间；改时间不能动描述 ────────────────────────────────────── */
check('改描述保留时间头',
  rewriteTaskDescription('- [ ] 18:00 - 18:50 吃饭 📅 2026-09-19 ⏫', '写代码'),
  '- [ ] 18:00 - 18:50 写代码 📅 2026-09-19 ⏫')
check('改描述保留单点时间',
  rewriteTaskDescription('- [ ] 9:05 起床', '早起'),
  '- [ ] 9:05 早起')
// 标签属于"描述"的一部分（页面上的输入框里就能看到它），所以改描述时以用户提交的文本为准：
// 编辑框里保留了 #life 就会被保留，删掉就删掉 —— 这是"所见即所写"，不是静默丢弃。
check('标签跟着描述走（输入框里看得见，所见即所写）',
  rewriteTaskDescription('- [ ] 9:05 起床 #life', '早起 #life'),
  '- [ ] 9:05 早起 #life')
check('改时间：给没时间的任务加时间',
  rewriteTaskTime('- [ ] 吃饭 📅 2026-09-19', '18:00', '18:50'),
  '- [ ] 18:00 - 18:50 吃饭 📅 2026-09-19')
check('改时间：替换已有时间（描述与元数据不动）',
  rewriteTaskTime('- [ ] 18:00 - 18:50 吃饭 ⏫ #work', '20:10', '20:40'),
  '- [ ] 20:10 - 20:40 吃饭 ⏫ #work')
check('改时间：只给开始时间',
  rewriteTaskTime('- [ ] 18:00 - 18:50 吃饭', '19:00', null),
  '- [ ] 19:00 吃饭')
check('改时间：清除时间（回到未安排）',
  rewriteTaskTime('- [ ] 18:00 - 18:50 吃饭 ⏫', null),
  '- [ ] 吃饭 ⏫')
check('改时间：取消态与缩进保留',
  rewriteTaskTime('  - [-] 18:00 旧安排', '21:00', '21:30'),
  '  - [-] 21:00 - 21:30 旧安排')
check('改时间：非法时间拒绝', rewriteTaskTime('- [ ] 吃饭', '25:00', null), null)
check('改时间：非任务行拒绝', rewriteTaskTime('## 标题', '18:00', null), null)
check('改时间后仍能被解析器读回', parseTaskLine(rewriteTaskTime('- [ ] 吃饭', '18:00', '18:50'), 'a.md', 1).durationMinutes, 50)

/* ── 字数统计（Calendar 插件的"每 250 词一个点"要用）──────────────────────── */
check('拉丁按词计', countWords('hello world foo'), 3)
check('CJK 逐字计', countWords('吃饭睡觉'), 4)
check('中英混排相加', countWords('吃饭 hello'), 3)
check('frontmatter 不计', countWords('---\ntags: [daily]\n---\n正文两个字'), 5)
check('代码块不计', countWords('正文\n```\nconsole.log(1)\n```\n结束'), 4)

const failed = results.filter((r) => !r.ok)
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ source: 'lib/index.js#Obsidian Tasks 解析 + 任务写回与日记', results }, null, 2) + '\n')
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
