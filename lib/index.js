/**
 * dsh-calendar — host 半边（DSH 插件包 dsh-calendar）
 *
 * 职责：
 *   1. `/preview`  只读 HTML：单文件日历页（侧栏面板内嵌的也是这一页）。
 *   2. `/tasks`    Obsidian Tasks 行 + 日记（daily note）扫描结果（JSON，只读）。
 *   3. `/tasks/toggle` 写回一条待办的完成状态（唯一的写操作，见"写回安全"）。
 *   4. `/notes/create` 某天没有日记时新建 `<root>/YYYY-MM-DD.md`（绝不覆盖）。
 *   5. `/status`   自检 JSON。
 *
 * 设计约束：
 * - 零外部 import：只用 node: 内建模块，不需要 cordis/dsh-tools 等 peerDependency 也能装配。
 * - 不硬声明 inject：一律 ctx.inject(deps, cb) "到货即装配"，缺服务也不影响插件本体。
 * - 扫描根由 `$DSH_HOME/dsh-calendar/config.json` 的 `roots` 决定（本机 = Obsidian 的日记文件夹）。
 *
 * 写回安全（用户已明确授权写回完成状态）：
 *   · 只允许改「已配置 root 之内」的 .md，且必须实测路径落在 root 真实路径之下（挡 ../ 与符号链接逃逸）
 *   · 只改一行、只动 `[ ]`↔`[x]` 与 `✅ YYYY-MM-DD`，行内其它字符一律原样保留
 *   · 乐观并发：请求带 `expect`（客户端看到的原文），与磁盘不符 → 409 stale，绝不盲写
 *   · 原子写：同目录临时文件 + rename 覆盖；保留原编码（BOM）与换行风格（CRLF/LF）
 *   · 每次写都追加审计记录到 `$DSH_HOME/dsh-calendar/writes.jsonl`（不进 vault）
 *   · 请求需带 `x-dsh-calendar: write` 头且 Origin 必须是本机 —— 挡掉跨站表单式误触
 */

import { readFile, readdir, realpath, rename, stat, writeFile, mkdir, access, constants } from 'node:fs/promises'
import { join, dirname, resolve, sep, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-calendar'

/** 路由前缀。同一会话里出现两条同前缀注册会抛 "duplicate prefix route"。 */
const ROUTE_PREFIX = '/dsh-calendar'
/** 单文件日历页的绝对路径（真源：standalone/calendar.html，与 lib/ 同级）。 */
const PAGE_URL = new URL('../standalone/calendar.html', import.meta.url)

/* ══════════════════════════════════════════════════════════════════════════════
 * Obsidian Tasks 解析
 * 行语法：`- [ ] 正文 📅 2026-09-20 ⏳ 2026-09-18 ⏫ #work`
 *  状态   [ ] 待办 · [x] 完成 · [-] 取消
 *  日期   📅 due（截止）· ⏳ scheduled（计划）· 🛫 start（开始）
 *  其它   ➕ created · ✅ done · ❌ cancelled · 🔁 重复规则
 *  优先级 🔺 highest · ⏫ high · 🔼 medium · 🔽 low · ⏬ lowest
 * 展示落点：due → scheduled → start（都没有 = 未排期，不上月历）
 * 这段被 scripts/tasks-parse.test.mjs 按标记抽取做回归测试。
 * ══════════════════════════════════════════════════════════════════════════════ */
// #region Obsidian Tasks 解析
const TASK_LINE = /^\s*[-*+]\s+\[([ xX-])\]\s?(.*)$/
const DATE_FIELDS = [['due', '📅'], ['scheduled', '⏳'], ['start', '🛫']]
const OTHER_FIELDS = [['created', '➕'], ['done', '✅'], ['cancelled', '❌']]
const PRIORITY_FIELDS = [['highest', '🔺'], ['high', '⏫'], ['medium', '🔼'], ['low', '🔽'], ['lowest', '⏬']]
const RECURRENCE = '🔁'
const ALL_META = [...DATE_FIELDS, ...OTHER_FIELDS].map(([, emoji]) => emoji).concat(PRIORITY_FIELDS.map(([, e]) => e), [RECURRENCE])
const TAG = /#[^\s#]+/gu
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Day Planner 的时间头：`18:00 - 18:50` / `18:00`，只认行首（复选框之后）。 */
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/
const TIME_PREFIX = /^(\s*)(\d{1,2}:\d{2}(?:\s*[-–—~]\s*\d{1,2}:\d{2})?)(?=\s|$)/

/** `HH:mm` → 自午夜起的分钟数；非法返回 null。 */
function clockToMinutes(value) {
  const m = CLOCK.exec(String(value === undefined || value === null ? '' : value).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 分钟数 → `HH:mm`（按 24h 回绕）。 */
function minutesToClock(minutes) {
  const n = ((Math.round(Number(minutes)) % 1440) + 1440) % 1440
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0')
}

/** 解析行首时间头；返回 { text, start, end, length } 或 null。 */
function parseTimePrefix(text) {
  const m = TIME_PREFIX.exec(String(text || ''))
  if (!m) return null
  const parts = m[2].split(/\s*[-–—~]\s*/)
  const start = clockToMinutes(parts[0])
  if (start === null) return null
  const end = parts.length > 1 ? clockToMinutes(parts[1]) : null
  if (parts.length > 1 && end === null) return null
  return { text: m[2], start, end, length: m[0].length }
}

/** `YYYY-MM-DD` 且月/日在合法范围内。 */
function isIsoDate(value) {
  const m = ISO_DATE.exec(String(value || ''))
  if (!m) return false
  const month = Number(m[2])
  const day = Number(m[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** 取 `emoji` 后面紧跟的 ISO 日期（允许一个空格）。 */
function readDateField(text, emoji) {
  const at = text.indexOf(emoji)
  if (at < 0) return null
  const m = /^\s*(\d{4}-\d{2}-\d{2})/.exec(text.slice(at + emoji.length))
  return m && isIsoDate(m[1]) ? m[1] : null
}

/** 取 `emoji` 后面到下一个元数据 emoji 之前的自由文本（用于 🔁 重复规则）。 */
function readTextField(text, emoji) {
  const at = text.indexOf(emoji)
  if (at < 0) return null
  const rest = text.slice(at + emoji.length)
  let end = rest.length
  for (const meta of ALL_META) {
    const i = rest.indexOf(meta)
    if (i >= 0 && i < end) end = i
  }
  const value = rest.slice(0, end).trim()
  return value === '' ? null : value
}

/** 去掉 `🔁 <规则>` 整段（按索引切，不能用 trim 后的长度反推——会多吃/少吃字符）。 */
function stripRecurrence(text) {
  const at = text.indexOf(RECURRENCE)
  if (at < 0) return text
  const rest = text.slice(at + RECURRENCE.length)
  let end = rest.length
  for (const meta of ALL_META) {
    const i = rest.indexOf(meta)
    if (i >= 0 && i < end) end = i
  }
  return text.slice(0, at) + ' ' + rest.slice(end)
}

/** 去掉正文里的元数据（日期/优先级/重复），保留其它文字与标签。 */
function cleanText(text) {
  let out = text
  for (const [, emoji] of [...DATE_FIELDS, ...OTHER_FIELDS]) {
    out = out.replace(new RegExp(emoji + '\\s*\\d{4}-\\d{2}-\\d{2}', 'g'), ' ')
  }
  out = stripRecurrence(out)
  for (const [, emoji] of PRIORITY_FIELDS) out = out.split(emoji).join(' ')
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 解析一行；不是任务行就返回 null。
 * @param line - 单行文本
 * @param file - 相对扫描根的路径（posix 分隔符）
 * @param lineNumber - 1 基行号
 */
function parseTaskLine(line, file, lineNumber) {
  const m = TASK_LINE.exec(line)
  if (!m) return null
  const raw = m[2] || ''
  const state = m[1] === ' ' ? 'todo' : m[1] === '-' ? 'cancelled' : 'done'
  // 行首时间头（Day Planner 语法）从正文里摘出来单独存，改写时才能原样保留
  const time = parseTimePrefix(raw)
  const body = time ? raw.slice(time.length) : raw
  const task = {
    file,
    line: lineNumber,
    raw: line,                       // 原始行：写回时的乐观并发凭据（expect）
    state,
    text: cleanText(body),
    timeText: time ? time.text : null,
    startTime: time ? minutesToClock(time.start) : null,
    endTime: time && time.end !== null ? minutesToClock(time.end) : null,
    startMinutes: time ? time.start : null,
    endMinutes: time && time.end !== null ? time.end : null,
    durationMinutes: time && time.end !== null ? Math.max(0, time.end - time.start) : null,
    due: readDateField(raw, '📅'),
    scheduled: readDateField(raw, '⏳'),
    start: readDateField(raw, '🛫'),
    created: readDateField(raw, '➕'),
    done: readDateField(raw, '✅'),
    cancelled: readDateField(raw, '❌'),
    priority: null,
    recurrence: readTextField(raw, RECURRENCE),
    tags: raw.match(TAG) || [],
  }
  for (const [level, emoji] of PRIORITY_FIELDS) {
    if (raw.includes(emoji)) { task.priority = level; break }
  }
  task.date = task.due || task.scheduled || task.start || null
  task.dateSource = task.date === null ? null : (task.due ? 'due' : task.scheduled ? 'scheduled' : 'start')
  return task
}

/** 逐行解析一个 Markdown 文件；跳过围栏代码块里的伪任务行。 */
function parseTasksInMarkdown(source, file) {
  const tasks = []
  let fence = null
  const lines = String(source).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1] : null
      continue
    }
    if (fence !== null) continue
    const task = parseTaskLine(line, file, i + 1)
    if (task) tasks.push(task)
  }
  return tasks
}

/** 按展示日期分桶（只收有日期的任务）。 */
function groupByDate(tasks) {
  const buckets = Object.create(null)
  let undated = 0
  for (const task of tasks) {
    if (!task.date) { undated += 1; continue }
    ;(buckets[task.date] = buckets[task.date] || []).push(task)
  }
  return { buckets, undated }
}
// #endregion

/* ══════════════════════════════════════════════════════════════════════════════
 * 写回与日记（纯函数部分，同样按标记抽取做回归测试）
 * ══════════════════════════════════════════════════════════════════════════════ */
// #region 任务写回与日记
/** 行首结构：缩进 + 项目符号 + `[x]` 本身，其余原样保留。 */
const CHECKBOX_LINE = /^(\s*[-*+]\s+\[)([ xX-])(\])/
const DONE_DATE_FIND = /✅\s*\d{4}-\d{2}-\d{2}/
const DONE_DATE_ALL = /\s*✅\s*\d{4}-\d{2}-\d{2}/g
const FILENAME_DATE = /^(\d{4})[-._年](\d{1,2})[-._月](\d{1,2})日?/
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/**
 * 从文件名识别日记日期：`2026-09-16` / `2026.09.16` / `2026_09_16` / `2026年9月16日` / `20260916`，
 * 允许后面带后缀（如 `2026-09-16 星期三`）。认不出或日期非法返回 null。
 */
function dateKeyFromBasename(basenameValue) {
  const raw = String(basenameValue || '').trim()
  const two = (n) => String(Number(n)).padStart(2, '0')
  const spaced = FILENAME_DATE.exec(raw)
  if (spaced) {
    const key = `${spaced[1]}-${two(spaced[2])}-${two(spaced[3])}`
    return isIsoDate(key) ? key : null
  }
  const compact = COMPACT_DATE.exec(raw)
  if (compact) {
    const key = `${compact[1]}-${compact[2]}-${compact[3]}`
    return isIsoDate(key) ? key : null
  }
  return null
}

/** `YYYY-MM-DD` → `2026年9月16日 星期三`。 */
function humanDate(dateKey) {
  const parts = String(dateKey).split('-')
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  return `${Number(parts[0])}年${Number(parts[1])}月${Number(parts[2])}日 ${WEEKDAY_CN[d.getDay()]}`
}

/**
 * 计算"切换完成状态"后的整行文本（纯函数，不碰文件）。
 * done=true  → `[x]`，并按 Obsidian Tasks 惯例追加/更新 `✅ YYYY-MM-DD`
 * done=false → `[ ]`，并移除 `✅ YYYY-MM-DD`
 * 行内其它字符（缩进、项目符号、正文、标签、优先级、其它日期）一律原样保留。
 * 不认识的行返回 null —— 写回必须拒绝而不是猜。
 *
 * @param line - 磁盘上的原始行
 * @param options - { done: boolean, date: 'YYYY-MM-DD', appendDoneDate?: boolean }
 */
function rewriteTaskLine(line, options) {
  const m = CHECKBOX_LINE.exec(String(line))
  if (!m) return null
  const rest = String(line).slice(m[0].length)
  const state = options.done ? 'x' : ' '
  if (options.appendDoneDate === false) return m[1] + state + m[3] + rest
  if (!options.done) return m[1] + state + m[3] + rest.replace(DONE_DATE_ALL, '')
  if (DONE_DATE_FIND.test(rest)) return m[1] + state + m[3] + rest.replace(DONE_DATE_ALL, ' ✅ ' + options.date)
  if (/^\s*$/.test(rest)) return m[1] + state + m[3] + ' ✅ ' + options.date
  return m[1] + state + m[3] + rest.replace(/\s+$/, '') + ' ✅ ' + options.date
}

/**
 * 把一行任务改写成新的**描述**（时间头、勾选状态、缩进、项目符号、元数据尾巴全部原样保留）。
 *
 * 保留区 = 复选框之前的前缀 + 行首时间头（`18:00 - 18:50`）+ 第一个元数据 emoji 之后的整段。
 * 于是"改任务内容"永远不会动到排好的时间，也不会丢元数据。
 * 不是任务行 → null（拒绝改写）。
 *
 * @param line - 磁盘上的原始行
 * @param text - 新的描述文本（换行与连续空白会被压成单个空格）
 */
function rewriteTaskDescription(line, text) {
  const m = CHECKBOX_LINE.exec(String(line))
  if (!m) return null
  // 描述里的换行与连续空白一律压成单个空格：写回结果确定，也和页面侧输入框的处理一致
  const description = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  const rest = String(line).slice(m[0].length)
  const time = parseTimePrefix(rest)
  const afterTime = time ? rest.slice(time.length) : rest
  const timePrefix = time ? ' ' + time.text : ''
  let cut = -1
  for (const meta of ALL_META) {
    const i = afterTime.indexOf(meta)
    if (i >= 0 && (cut < 0 || i < cut)) cut = i
  }
  const tail = cut < 0 ? '' : afterTime.slice(cut).replace(/\s+$/, '')
  const head = description === '' ? '' : ' ' + description
  return m[1] + m[2] + m[3] + timePrefix + head + (tail === '' ? '' : ' ' + tail.replace(/^\s+/, ''))
}

/**
 * 改写一条任务的行首时间头（Day Planner 的 `start - end` / `start`；start=null 表示清除时间）。
 * 描述与元数据原样保留。
 *
 * @param line - 磁盘上的原始行
 * @param start - `HH:mm` 或 null（清除）
 * @param end - `HH:mm` 或 null（只写开始时间）
 */
function rewriteTaskTime(line, start, end) {
  const m = CHECKBOX_LINE.exec(String(line))
  if (!m) return null
  const startMinutes = start === null || start === undefined ? null : clockToMinutes(start)
  if (start !== null && start !== undefined && startMinutes === null) return null
  const endMinutes = end === null || end === undefined ? null : clockToMinutes(end)
  if (end !== null && end !== undefined && endMinutes === null) return null
  const rest = String(line).slice(m[0].length)
  const time = parseTimePrefix(rest)
  const body = (time ? rest.slice(time.length) : rest).replace(/^\s+/, '')
  if (startMinutes === null) {
    return m[1] + m[2] + m[3] + (body === '' ? '' : ' ' + body)
  }
  const token = endMinutes === null ? minutesToClock(startMinutes) : minutesToClock(startMinutes) + ' - ' + minutesToClock(endMinutes)
  return m[1] + m[2] + m[3] + ' ' + token + (body === '' ? '' : ' ' + body)
}

/** 新建日记的首行标题，如 `# 2026-09-16 星期三`。 */
function noteTitleFor(dateKey, template) {
  const pattern = typeof template === 'string' && template.trim() !== '' ? template : '# {date} {weekday}'
  return pattern
    .replace(/\{date\}/g, dateKey)
    .replace(/\{weekday\}/g, WEEKDAY_CN[new Date(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10))).getDay()])
    .replace(/\{human\}/g, humanDate(dateKey))
}

/**
 * 粗算字数：CJK 逐字算一个词、拉丁按空白分词（口径接近 Obsidian 自己的字数统计）。
 * 供 Calendar 插件风格的"每 250 词一个点"使用。
 */
function countWords(source) {
  const text = String(source || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')   // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')                    // 代码块
    .replace(/`[^`]*`/g, ' ')                           // 行内代码
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')             // 链接/图片
    .replace(/[#>*_~]/g, ' ')
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length
  const latin = (text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length
  return cjk + latin
}

/**
 * 日记正文摘要：去掉 frontmatter、围栏代码块与任务行，压掉多余空行，截断到 limit 字符。
 * 任务行不进摘要 —— 它们已经单独列在任务列表里。
 */
function noteExcerpt(source, limit = 800) {
  const lines = String(source).split(/\r?\n/)
  const out = []
  let fence = null
  let front = false
  let seenContent = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0 && /^---\s*$/.test(line)) { front = true; continue }
    if (front) { if (/^---\s*$/.test(line)) front = false; continue }
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) { fence = fence === null ? fenceMatch[1] : null; continue }
    if (fence !== null) continue
    if (TASK_LINE.test(line)) { seenContent = true; continue }
    const stripped = line.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+$/, '')
    if (stripped === '') { if (out.length > 0) out.push(''); continue }
    out.push(stripped)
    seenContent = true
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n')
  if (text === '' ) return seenContent ? '' : ''
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text
}
// #endregion

export const __internals = {
  parseTaskLine, parseTasksInMarkdown, groupByDate, cleanText, isIsoDate,
  dateKeyFromBasename, rewriteTaskLine, rewriteTaskDescription, rewriteTaskTime,
  clockToMinutes, minutesToClock, parseTimePrefix, countWords,
  noteExcerpt, noteTitleFor, humanDate,
}

/** 给「AI / 命令行」用的安装接口：scripts/setup.mjs 与 HTTP /setup 共用同一套实现。 */
export const __setup = {
  parseDailyNotesConfig,
  dateFormatFor,
  candidateParents,
  detectVaults,
  vaultCandidate,
  validateRootPath,
  writeConfigRoot,
  configPath,
  dshHome,
  dshHomeInfo,
  readConfig: async () => {
    try {
      return JSON.parse(await readFile(configPath(), 'utf8'))
    } catch {
      return null
    }
  },
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 配置：$DSH_HOME/dsh-calendar/config.json（本机 = Obsidian 日记文件夹）
 * ══════════════════════════════════════════════════════════════════════════════ */
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.dsh', 'dist', 'build', 'out'])
const MAX_FILES = 600
const MAX_BYTES = 8 * 1024 * 1024
const MAX_TASKS = 3000
const MAX_DEPTH = 8
const MAX_NOTE_BYTES = 256 * 1024
const EXCERPT_CHARS = 800
const SCAN_CACHE_MS = 2500

const DEFAULT_CONFIG = {
  roots: [],
  allowAnyRoot: false,
  write: { enabled: true, appendDoneDate: true },
  create: { enabled: true, titleTemplate: '# {date} {weekday}' },
  // 与 Obsidian 的 obsidian-day-planner 对齐：这些默认值就是该插件 data.json 里的同名项
  dayPlanner: {
    heading: 'Day planner',        // plannerHeading
    headingLevel: 1,               // plannerHeadingLevel
    startHour: 6,                  // startHour
    defaultDurationMinutes: 30,    // defaultDurationMinutes
    minimalDurationMinutes: 10,    // minimalDurationMinutes
    snapStepMinutes: 10,           // snapStepMinutes
    showNow: true,                 // showNow
    showNext: true,                // showNext
  },
  // 与 Obsidian 的 calendar（Liam Cain）对齐：每写满 wordsPerDot 个字，日期下多一个点
  calendar: {
    wordsPerDot: 250,              // wordsPerDot
    maxNoteDots: 2,                // 面板窄，最多两枚
  },
  /** 进入会话时自动展开日历 tab（client 半边读 /status 的这个开关；默认开）。 */
  autoOpen: true,
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * DSH 家目录是从哪来的（给 CLI/AI 看）：env 优先，否则 ~/.dsh。
 * `looksLikeDshHome` 用于提醒"你可能指错了地方"——running 中的插件以 /status 的 configPath 为准。
 */
async function dshHomeInfo() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  const home = dshHome()
  const looksLikeDshHome = Boolean(await realDir(join(home, 'profiles'))) || Boolean(await realDir(join(home, 'storages')))
  return { home, source: fromEnv ? 'env' : 'fallback', looksLikeDshHome }
}

function configPath() {
  return join(dshHome(), 'dsh-calendar', 'config.json')
}

function auditPath() {
  return join(dshHome(), 'dsh-calendar', 'writes.jsonl')
}

/** 读配置：文件优先于 loader 行配置；文件缺失/损坏就用手上的配置（不抛）。 */
async function loadConfig(rowConfig) {
  const base = {
    ...DEFAULT_CONFIG,
    ...(rowConfig || {}),
    write: { ...DEFAULT_CONFIG.write, ...((rowConfig || {}).write || {}) },
    create: { ...DEFAULT_CONFIG.create, ...((rowConfig || {}).create || {}) },
    dayPlanner: { ...DEFAULT_CONFIG.dayPlanner, ...((rowConfig || {}).dayPlanner || {}) },
    calendar: { ...DEFAULT_CONFIG.calendar, ...((rowConfig || {}).calendar || {}) },
  }
  try {
    const file = JSON.parse(await readFile(configPath(), 'utf8'))
    return {
      ...base,
      ...file,
      write: { ...base.write, ...(file.write || {}) },
      create: { ...base.create, ...(file.create || {}) },
      dayPlanner: { ...base.dayPlanner, ...(file.dayPlanner || {}) },
      calendar: { ...base.calendar, ...(file.calendar || {}) },
      roots: Array.isArray(file.roots) ? file.roots.filter((r) => typeof r === 'string' && r.trim() !== '') : base.roots,
    }
  } catch {
    return base
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 扫描
 * ══════════════════════════════════════════════════════════════════════════════ */
/** Windows 上路径大小写不敏感，比较前统一规范化。 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '')
  const left = norm(a)
  const right = norm(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 把绝对路径规范成真实目录路径；不是目录则返回 null。 */
async function realDir(path) {
  try {
    const real = await realpath(path)
    return (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** 递归收集 *.md（不跟随符号链接目录，跳过噪声目录与隐藏目录）。 */
async function collectMarkdown(root) {
  const files = []
  let bytes = 0
  let truncated = false
  const walk = async (dir, depth) => {
    if (truncated || depth > MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      let size = 0
      try {
        size = (await stat(full)).size
      } catch {
        continue
      }
      if (files.length >= MAX_FILES || bytes + size > MAX_BYTES) {
        truncated = true
        return
      }
      files.push({ full, size })
      bytes += size
    }
  }
  await walk(root, 0)
  return { files, bytes, truncated }
}

/** 扫描一个根：任务 + 日记（按文件名里的日期识别）。 */
async function scanTasks(root) {
  const { files, bytes, truncated } = await collectMarkdown(root)
  const tasks = []
  const notes = {}
  let clipped = truncated

  for (const entry of files) {
    let source
    try {
      source = await readFile(entry.full, 'utf8')
    } catch {
      continue
    }
    const rel = relativePosix(root, entry.full)
    // 日记（文件名带日期）里的待办没有显式日期时，算作那一天 —— 这是日记工作流的默认预期：
    // 在 2026-09-16.md 里写 `- [ ] 睡觉`，它就该出现在 9/16 那天，而不是"未排期"。
    const noteDate = dateKeyFromBasename(basename(entry.full, '.md'))
    const parsed = parseTasksInMarkdown(source, rel)
    for (const task of parsed) {
      if (!task.date && noteDate) {
        task.date = noteDate
        task.dateSource = 'note'
      }
    }
    for (const task of parsed) {
      if (tasks.length >= MAX_TASKS) { clipped = true; break }
      tasks.push(task)
    }
    if (noteDate && !notes[noteDate] && entry.size <= MAX_NOTE_BYTES) {
      let mtime = null
      try { mtime = (await stat(entry.full)).mtime.toISOString() } catch { /* 忽略 */ }
      notes[noteDate] = {
        date: noteDate,
        file: rel,
        title: basename(entry.full),
        bytes: entry.size,
        words: countWords(source),
        mtime,
        excerpt: noteExcerpt(source, EXCERPT_CHARS),
        taskCount: parsed.length,
      }
    }
  }

  const { buckets, undated } = groupByDate(tasks)
  return {
    root,
    scanned: { files: files.length, bytes, truncated: clipped },
    counts: {
      tasks: tasks.length,
      dated: tasks.length - undated,
      undated,
      done: tasks.filter((t) => t.state === 'done').length,
      cancelled: tasks.filter((t) => t.state === 'cancelled').length,
      open: tasks.filter((t) => t.state === 'todo').length,
      notes: Object.keys(notes).length,
    },
    notes,
    tasks,
    buckets,
  }
}

/** 相对路径统一成 posix 分隔符（前端与 URL 都用这个）。 */
function relativePosix(root, file) {
  const rel = resolve(file).slice(resolve(root).length)
  return rel.replace(/^[\\/]+/, '').split(sep).join('/')
}

/** 扫描缓存：按 root 缓存一小会儿，避免每次轮询都重扫。 */
const scanCache = new Map()

async function cachedScan(root, refresh) {
  const hit = scanCache.get(root)
  if (!refresh && hit && Date.now() - hit.at < SCAN_CACHE_MS) return { payload: hit.payload, cached: true }
  const payload = await scanTasks(root)
  scanCache.set(root, { at: Date.now(), payload })
  return { payload, cached: false }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 写回
 * ══════════════════════════════════════════════════════════════════════════════ */
/** 每个文件一条写队列：同一文件的写串行，避免并发读改写互相覆盖。 */
const writeChains = new Map()

function withFileLock(file, task) {
  const previous = writeChains.get(file) || Promise.resolve()
  const run = previous.then(task, task)
  writeChains.set(file, run.then(() => undefined, () => undefined))
  return run
}

/** 目标必须真实落在 root 之内、且是 .md 文件（挡 ../ 与符号链接逃逸）。 */
async function resolveInsideRoot(root, relative) {
  const rootReal = await realpath(root).catch(() => null)
  if (!rootReal) return { error: 'root-missing' }
  const candidate = resolve(rootReal, String(relative || ''))
  let real
  try {
    real = await realpath(candidate)
  } catch {
    return { error: 'file-missing' }
  }
  const inside = real === rootReal || real.startsWith(rootReal + sep)
  if (!inside) return { error: 'outside-root' }
  if (!/\.md$/i.test(real)) return { error: 'not-markdown' }
  try {
    if (!(await stat(real)).isFile()) return { error: 'not-a-file' }
  } catch {
    return { error: 'file-missing' }
  }
  return { file: real }
}

/** 原子写：同目录临时文件 + rename 覆盖（Windows 上 rename 会替换目标）。 */
async function writeTextAtomic(target, text) {
  const tmp = join(dirname(target), `.dsh-calendar-${process.pid}-${Date.now().toString(36)}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, target)
}

/** 追加一条审计记录（失败不影响主流程）。 */
async function audit(record) {
  try {
    await mkdir(dirname(auditPath()), { recursive: true })
    await writeFile(auditPath(), JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* 审计失败不阻断 */ }
}

/**
 * 所有写回共用的安全外壳：解析目标 → 串行 → 读盘（保 BOM/换行）→ 定位行 →
 * 乐观并发校验（expect）→ 交给 transform 产出新行 → 原子写 → 回读校验 → 审计。
 *
 * @param root - 已解析的扫描根
 * @param body - { file, line, expect, ... }
 * @param transform - (beforeLine, ctx) => { after, action } 或 { error }
 * @returns {{ok:true, changed:boolean, line:number, before:string, after:string}} 或 {{error:string}}
 */
async function mutateTaskLine(root, body, transform) {
  const target = await resolveInsideRoot(root, body.file)
  if (target.error) return target

  return withFileLock(target.file, async () => {
    let raw
    try {
      raw = await readFile(target.file)
    } catch {
      return { error: 'file-missing' }
    }
    const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    const decoded = raw.toString('utf8')
    const content = hasBom ? decoded.slice(1) : decoded
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const lines = content.split(/\r?\n/)

    const index = Number(body.line) - 1
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) return { error: 'line-out-of-range' }
    const before = lines[index]
    if (typeof body.expect === 'string' && body.expect !== before) {
      return { error: 'stale', current: before }
    }
    if (!TASK_LINE.test(before)) return { error: 'not-a-task' }

    const outcome = transform(before, {
      date: typeof body.date === 'string' && isIsoDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
      line: index + 1,
    })
    if (!outcome || outcome.error) return outcome || { error: 'bad-request' }
    const after = outcome.after
    if (typeof after !== 'string') return { error: 'bad-request' }
    if (after === before) {
      return { ok: true, changed: false, line: index + 1, before, after: before, action: outcome.action }
    }

    lines[index] = after
    try {
      await writeTextAtomic(target.file, (hasBom ? '\uFEFF' : '') + lines.join(eol))
    } catch (error) {
      return { error: 'write-failed', message: String((error && error.message) || error) }
    }

    // 写后回读校验：不一致就是没写成功（例如被编辑器锁住/回滚）
    let verify
    try {
      verify = (await readFile(target.file, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)[index]
    } catch {
      verify = undefined
    }
    if (verify !== after) return { error: 'verify-failed', expected: after, actual: verify }

    scanCache.delete(root)
    await audit({ at: new Date().toISOString(), action: outcome.action, file: body.file, line: index + 1, before, after })
    return { ok: true, changed: true, line: index + 1, before, after, action: outcome.action }
  })
}

/**
 * 切换一条待办的完成状态。
 * @returns {{ok:true, line:number, before:string, after:string}} 或 {{error:string}}
 */
async function toggleTask(root, body) {
  const done = body.done !== false
  return mutateTaskLine(root, body, (before, ctx) => {
    const current = parseTaskLine(before, body.file, ctx.line)
    if (current === null) return { error: 'not-a-task' }
    const already = done ? current.state === 'done' : current.state === 'todo'
    if (already) return { after: before, action: done ? 'complete' : 'reopen' }
    const after = rewriteTaskLine(before, { done, date: ctx.date, appendDoneDate: true })
    if (after === null) return { error: 'not-a-task' }
    return { after, action: done ? 'complete' : 'reopen' }
  })
}

/**
 * 改写一条待办的**描述**（勾选状态与元数据尾巴原样保留）。
 * @returns {{ok:true, line:number, before:string, after:string}} 或 {{error:string}}
 */
async function updateTask(root, body) {
  if (typeof body.text !== 'string') return { error: 'bad-text' }
  if (/[\r\n]/.test(body.text)) return { error: 'bad-text' }
  if (body.text.length > 500) return { error: 'text-too-long' }
  if (body.text.trim() === '') return { error: 'bad-text' }
  return mutateTaskLine(root, body, (before) => {
    const after = rewriteTaskDescription(before, body.text)
    if (after === null) return { error: 'not-a-task' }
    return { after, action: 'edit' }
  })
}

/**
 * 改写一条待办的行首时间（Day Planner 的 `HH:mm - HH:mm`；start=null 表示清除时间）。
 * @returns {{ok:true, line:number, before:string, after:string}} 或 {{error:string}}
 */
async function scheduleTask(root, body) {
  const startRaw = body.start === undefined || body.start === null || body.start === '' ? null : String(body.start)
  const endRaw = body.end === undefined || body.end === null || body.end === '' ? null : String(body.end)
  if (startRaw === null && endRaw !== null) return { error: 'bad-time' }
  if (startRaw !== null && clockToMinutes(startRaw) === null) return { error: 'bad-time' }
  if (endRaw !== null && clockToMinutes(endRaw) === null) return { error: 'bad-time' }
  if (startRaw !== null && endRaw !== null && clockToMinutes(endRaw) <= clockToMinutes(startRaw)) return { error: 'bad-time' }
  return mutateTaskLine(root, body, (before) => {
    const after = rewriteTaskTime(before, startRaw, endRaw)
    if (after === null) return { error: 'not-a-task' }
    return { after, action: startRaw === null ? 'unschedule' : 'schedule' }
  })
}

/**
 * 新建一条待办：带时间就写进 `# Day planner` 小节（没有就建），不带时间就追加到日记末尾。
 * 当天的日记不存在时会先按 titleTemplate 建出来。**只追加，绝不覆盖已有内容。**
 * @returns {{ok:true, file:string, line:string, created:boolean}} 或 {{error:string}}
 */
async function addTask(root, body, config) {
  const date = String(body.date || '')
  if (!isIsoDate(date)) return { error: 'bad-date' }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim()
  if (text === '') return { error: 'bad-text' }
  if (text.length > 200) return { error: 'text-too-long' }
  const startRaw = body.start === undefined || body.start === null || body.start === '' ? null : String(body.start)
  const endRaw = body.end === undefined || body.end === null || body.end === '' ? null : String(body.end)
  if (startRaw === null && endRaw !== null) return { error: 'bad-time' }
  const startMinutes = startRaw === null ? null : clockToMinutes(startRaw)
  const endMinutes = endRaw === null ? null : clockToMinutes(endRaw)
  if (startRaw !== null && startMinutes === null) return { error: 'bad-time' }
  if (endRaw !== null && endMinutes === null) return { error: 'bad-time' }
  if (startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes) return { error: 'bad-time' }

  const planner = (config && config.dayPlanner) || DEFAULT_CONFIG.dayPlanner
  const titleTemplate = config && config.create ? config.create.titleTemplate : undefined
  const target = join(root, date + '.md')

  return withFileLock(target, async () => {
    let existing = null
    try {
      existing = await readFile(target, 'utf8')
    } catch {
      existing = null
    }
    const hasBom = existing !== null && existing.charCodeAt(0) === 0xfeff
    const content = existing === null ? '' : (hasBom ? existing.slice(1) : existing)
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const taskLine = startMinutes === null
      ? '- [ ] ' + text
      : '- [ ] ' + minutesToClock(startMinutes) + (endMinutes === null ? '' : ' - ' + minutesToClock(endMinutes)) + ' ' + text

    const created = existing === null
    const lines = created ? [noteTitleFor(date, titleTemplate), ''] : content.split(/\r?\n/)

    if (startMinutes === null) {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      lines.push('', taskLine)
    } else {
      const level = Math.max(1, Math.min(6, Number(planner.headingLevel) || 1))
      const headingName = String(planner.heading || 'Day planner').trim()
      const heading = '#'.repeat(level) + ' ' + headingName
      const wanted = headingName.toLowerCase()
      let at = -1
      for (let i = 0; i < lines.length; i++) {
        const text_ = lines[i].trim()
        if (/^#{1,6}\s/.test(text_) && text_.replace(/^#{1,6}\s*/, '').trim().toLowerCase() === wanted) { at = i; break }
      }
      if (at < 0) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
        lines.push('', heading, '', taskLine)
      } else {
        let stop = lines.length
        for (let i = at + 1; i < lines.length; i++) {
          if (/^#{1,6}\s/.test(lines[i].trim())) { stop = i; break }
        }
        while (stop - 1 > at && lines[stop - 1].trim() === '') stop--
        lines.splice(stop, 0, taskLine)
      }
    }

    const expected = lines.join(eol).replace(/\s+$/, '') + eol
    try {
      await writeTextAtomic(target, (hasBom ? '\uFEFF' : '') + expected)
    } catch (error) {
      return { error: 'write-failed', message: String((error && error.message) || error) }
    }
    let verify
    try {
      verify = await readFile(target, 'utf8')
    } catch {
      verify = undefined
    }
    if (verify !== (hasBom ? '\uFEFF' : '') + expected) return { error: 'verify-failed' }

    scanCache.delete(root)
    await audit({ at: new Date().toISOString(), action: 'add-task', file: date + '.md', after: taskLine })
    return { ok: true, created, file: date + '.md', added: taskLine, scheduled: startMinutes !== null }
  })
}

/**
 * 新建某天的日记（绝不覆盖已有文件）。
 * @returns {{ok:true, file:string, created:true}} 或 {{error:string}}
 */
async function createNote(root, body) {
  const date = String(body.date || '')
  if (!isIsoDate(date)) return { error: 'bad-date' }
  const target = join(root, `${date}.md`)
  try {
    await access(target, constants.F_OK)
    return { error: 'exists', file: `${date}.md` }
  } catch { /* 不存在 → 继续 */ }
  const title = noteTitleFor(date, body.titleTemplate)
  const content = `${title}\n\n`
  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error && error.code === 'EEXIST') return { error: 'exists', file: `${date}.md` }
    return { error: 'create-failed', message: String((error && error.message) || error) }
  }
  scanCache.delete(root)
  await audit({ at: new Date().toISOString(), action: 'create-note', file: `${date}.md` })
  return { ok: true, created: true, file: `${date}.md`, title }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 首次配置（安装向导）：找 Obsidian vault → 选日记文件夹 → 写进本插件配置
 * 这一节同时是"给 AI 预留的接口"：scripts/setup.mjs 与 HTTP /setup 共用同一套实现。
 * ══════════════════════════════════════════════════════════════════════════════ */
const VAULT_MARKER = '.obsidian'
const MAX_DETECTED = 12

/** 太宽的目标一律拒绝（整盘 / 系统目录 / 用户主目录本身），避免"扫描+写回"落到危险范围。 */
const FORBIDDEN_ROOTS = [
  /^[a-z]:[\\/]?$/i,                                   // Windows 盘根：C:\
  /^\/+$/,                                             // POSIX 根：/
  /[\\/]windows([\\/]|$)/i,
  /[\\/]program files( \(x86\))?([\\/]|$)/i,
  /[\\/]programdata([\\/]|$)/i,
  /[\\/]appdata([\\/]|$)/i,
  /^[a-z]:[\\/]users[\\/][^\\/]+$/i,                   // C:\Users\me
  /^\/(home|users|root)\/[^/]+$/i,                     // /home/me · /Users/me · /root
  /^\/system([\\/]|$)/i,                               // macOS
  /^\/volumes([\\/]|$)/i,
]

/** 解析 Obsidian 核心插件 Daily Notes 的配置（`.obsidian/daily-notes.json`）。 */
function parseDailyNotesConfig(json) {
  const data = json && typeof json === 'object' ? json : {}
  const folder = typeof data.folder === 'string' ? data.folder.trim() : ''
  const format = typeof data.format === 'string' && data.format.trim() !== '' ? data.format.trim() : 'YYYY-MM-DD'
  return { folder, format }
}

/** 把 Obsidian 的日期格式串归类成我们能识别的命名风格（用于提示，不改变解析：解析是按文件名认的）。 */
function dateFormatFor(format) {
  const f = String(format || '')
  if (/YYYYMMDD|YYYYMMDD/.test(f)) return 'YYYYMMDD'
  if (f.includes('年')) return 'YYYY年M月D日'
  if (f.includes('.')) return 'YYYY.MM.DD'
  if (f.includes('_')) return 'YYYY_MM_DD'
  return 'YYYY-MM-DD'
}

/** 候选父目录：只找常见位置，不扫全盘。 */
function candidateParents() {
  const home = homedir()
  const list = [
    join(home, 'Documents'),
    join(home, 'Documents', 'Obsidian'),
    join(home, 'Obsidian'),
    join(home, 'Desktop'),
    join(home, 'OneDrive', 'Documents'),
    join(home, 'iCloudDrive'),
  ]
  if (process.platform === 'win32') for (const drive of ['C:', 'D:', 'E:', 'F:']) list.push(drive + '\\')
  else { list.push(home, '/Volumes') }
  return list
}

/** 一个目录是不是 Obsidian vault（含 .obsidian 标记目录）。 */
async function isObsidianVault(dir) {
  return Boolean(await realDir(join(dir, VAULT_MARKER)))
}

/** 把一个 vault 变成"可用配置"：优先用它配置的日记文件夹，没有就用 vault 根。 */
async function vaultCandidate(vault) {
  let daily = { folder: '', format: 'YYYY-MM-DD' }
  let hasDailyConfig = false
  try {
    daily = parseDailyNotesConfig(JSON.parse(await readFile(join(vault, VAULT_MARKER, 'daily-notes.json'), 'utf8')))
    hasDailyConfig = true
  } catch { /* 没配过 Daily Notes → 用 vault 根 + 默认格式 */ }

  let dayPlanner = null
  try {
    const raw = JSON.parse(await readFile(join(vault, VAULT_MARKER, 'plugins', 'obsidian-day-planner', 'data.json'), 'utf8'))
    dayPlanner = { installed: true, timelineDateFormat: raw.timelineDateFormat || 'YYYY-MM-DD', startHour: raw.startHour ?? 6 }
  } catch { dayPlanner = { installed: false } }

  let calendar = null
  try {
    const raw = JSON.parse(await readFile(join(vault, VAULT_MARKER, 'plugins', 'calendar', 'data.json'), 'utf8'))
    calendar = { installed: true, wordsPerDot: raw.wordsPerDot ?? 250 }
  } catch { calendar = { installed: false } }

  const wanted = daily.folder ? join(vault, daily.folder) : vault
  const root = (await realDir(wanted)) || vault
  return {
    vault,
    name: basename(vault),
    dailyFolder: daily.folder,
    root,
    hasDailyConfig,
    dateFormat: dateFormatFor(daily.format),
    dayPlanner,
    calendar,
  }
}

/** 找本机的 Obsidian vault：常见父目录 + 下探一层。 */
async function detectVaults() {
  const found = []
  const seen = new Set()
  const remember = async (dir) => {
    const real = await realDir(dir)
    if (!real || seen.has(real.toLowerCase()) || found.length >= MAX_DETECTED) return
    seen.add(real.toLowerCase())
    found.push(await vaultCandidate(real))
  }
  for (const parent of candidateParents()) {
    if (found.length >= MAX_DETECTED) break
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_DETECTED) break
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(parent, entry.name)
      if (await isObsidianVault(dir)) { await remember(dir); continue }
      let children
      try {
        children = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (found.length >= MAX_DETECTED) break
        if (!child.isDirectory() || child.name.startsWith('.')) continue
        const nested = join(dir, child.name)
        if (await isObsidianVault(nested)) await remember(nested)
      }
    }
  }
  return found
}

/** 校验用户填的路径能不能当扫描根。 */
async function validateRootPath(candidate) {
  const raw = String(candidate === undefined || candidate === null ? '' : candidate).trim().replace(/^["']|["']$/g, '')
  if (raw === '') return { error: 'empty-path' }
  const dir = await realDir(raw)
  if (!dir) return { error: 'not-a-directory', path: raw }
  for (const bad of FORBIDDEN_ROOTS) {
    if (bad.test(dir)) return { error: 'too-broad', path: dir }
  }
  return { root: dir }
}

/** 把扫描根写进插件配置（保留其它键；新根排在最前 = 成为主数据源）。 */
async function writeConfigRoot(root) {
  let current = {}
  try {
    current = JSON.parse(await readFile(configPath(), 'utf8'))
  } catch { current = {} }
  const existing = Array.isArray(current.roots) ? current.roots.filter((r) => typeof r === 'string') : []
  const roots = [root, ...existing.filter((r) => !samePath(r, root))].slice(0, 3)
  const next = { ...DEFAULT_CONFIG, ...current, roots }
  next.write = { ...DEFAULT_CONFIG.write, ...(current.write || {}) }
  next.create = { ...DEFAULT_CONFIG.create, ...(current.create || {}) }
  next.dayPlanner = { ...DEFAULT_CONFIG.dayPlanner, ...(current.dayPlanner || {}) }
  next.calendar = { ...DEFAULT_CONFIG.calendar, ...(current.calendar || {}) }
  await mkdir(dirname(configPath()), { recursive: true })
  await writeTextAtomic(configPath(), JSON.stringify(next, null, 2) + '\n')
  scanCache.clear()
  await audit({ at: new Date().toISOString(), action: 'set-root', root })
  return next
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 路由
 * ══════════════════════════════════════════════════════════════════════════════ */
function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendJson(res, status, payload, head) {
  const body = JSON.stringify(payload, null, 2) + '\n'
  sendText(res, status, head ? '' : body, 'application/json; charset=utf-8')
}

/** 读 client-modules 的合成图：本包 client 半边是否登记，以及它真实的加载 URL。 */
function clientModuleState(clientModules) {
  if (!clientModules || typeof clientModules.graph !== 'function') return null
  try {
    const graph = clientModules.graph()
    const rows = graph && Array.isArray(graph.entries) ? graph.entries : []
    const idOf = (row) => (typeof row === 'string' ? row : (row && (row.id ?? (row.entry && row.entry.id))) || null)
    const mine = rows.find((row) => idOf(row) === name) || null
    // client-modules 把每个 bundle 编成 combo 路由 `/plugins/??<id>/client.js&rev=<rev>`；
    // 单独访问 `/plugins/<id>/client.js`（没有 `??`）是 404，所以这里报真实的那一条。
    return {
      registered: mine !== null,
      rows: rows.length,
      rev: mine && typeof mine === 'object' ? mine.rev : ((graph && graph.rev) || null),
      url: mine && typeof mine === 'object' ? mine.url : null,
      specifier: name + '/client',
    }
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw === '' ? {} : JSON.parse(raw)
}

/** 写操作闸门：要求自定义头 + Origin 是本机，挡掉跨站表单式误触。 */
function writeGuard(req) {
  if (req.headers['x-dsh-calendar'] !== 'write') return 'missing-write-header'
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return 'bad-origin'
  return null
}

/** 允许的来源根集合：配置里的 roots + 显式 root 参数 + 已注册工作区。 */
async function allowedRoots(refs, config) {
  const list = []
  for (const candidate of config.roots) {
    const dir = await realDir(candidate)
    if (dir) list.push(dir)
  }
  try {
    for (const record of (refs.workspaces && typeof refs.workspaces.list === 'function' ? refs.workspaces.list() : []) || []) {
      if (record && typeof record.path === 'string') {
        const dir = await realDir(record.path)
        if (dir) list.push(dir)
      }
    }
  } catch { /* 注册表不可用 */ }
  return list
}

/** 会话工作目录（用于 ?root=@session 或没配 roots 时的兜底）。 */
async function sessionRoot(refs, sessionId) {
  if (!sessionId) return null
  try {
    const session = refs.sessions && typeof refs.sessions.get === 'function' ? refs.sessions.get(sessionId) : null
    const cwd = session && session.header ? session.header.cwd : null
    return cwd ? await realDir(cwd) : null
  } catch {
    return null
  }
}

/**
 * 解析扫描根：`?root=`（须在允许集合内，或 `@session`）→ 配置里的第一个 root → 会话工作目录
 * → 第一个已注册工作区。配置了 roots 就优先用配置 —— 面板里要看到的是"我的笔记库"，
 * 而不是当前会话的工作目录。
 */
async function resolveRoot(refs, config, url) {
  const dirs = await allowedRoots(refs, config)
  const sessionId = url.searchParams.get('session')
  const asked = url.searchParams.get('root')

  if (asked === '@session') {
    const dir = await sessionRoot(refs, sessionId)
    return dir ? { root: dir, source: 'session' } : { error: 'no-session-workspace' }
  }
  if (asked) {
    const dir = await realDir(asked)
    if (!dir) return { error: 'root-not-found', asked }
    if (!config.allowAnyRoot && !dirs.some((candidate) => samePath(candidate, dir))) {
      return { error: 'root-not-allowed', asked, allowed: dirs }
    }
    return { root: dir, source: 'root-param' }
  }
  for (const candidate of config.roots) {
    const dir = await realDir(candidate)
    if (dir) return { root: dir, source: 'config' }
  }
  const fromSession = await sessionRoot(refs, sessionId)
  if (fromSession) return { root: fromSession, source: 'session' }
  if (dirs.length > 0) return { root: dirs[0], source: 'workspace' }
  return { error: 'no-workspace', allowed: dirs }
}

function createHandler(refs, rowConfig) {
  return async function handleCalendar(req, res) {
    const url = new URL(req.url || '/', 'http://dsh.invalid')
    const route = url.pathname.replace(/\/+$/, '')
    const head = req.method === 'HEAD'
    const config = await loadConfig(rowConfig)

    /* ── 写操作 ─────────────────────────────────────────────────────────── */
    if (route.endsWith('/tasks/toggle') || route.endsWith('/tasks/update') || route.endsWith('/tasks/schedule') ||
        route.endsWith('/tasks/add') || route.endsWith('/notes/create')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', allow: 'POST' }, head)
        return
      }
      const blocked = writeGuard(req)
      if (blocked) {
        sendJson(res, 403, { ok: false, error: blocked }, head)
        return
      }
      const resolved = await resolveRoot(refs, config, url)
      if (resolved.error) {
        sendJson(res, 200, { ok: false, error: resolved.error, allowed: resolved.allowed || [] }, head)
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad-body', message: String((error && error.message) || error) }, head)
        return
      }

      if (route.endsWith('/notes/create')) {
        if (!config.create || config.create.enabled === false) {
          sendJson(res, 403, { ok: false, error: 'create-disabled' }, head)
          return
        }
        const result = await createNote(resolved.root, { ...body, titleTemplate: config.create && config.create.titleTemplate })
        sendJson(res, result.ok ? 200 : (result.error === 'exists' ? 409 : 400), result, head)
        return
      }

      if (!config.write || config.write.enabled === false) {
        sendJson(res, 403, { ok: false, error: 'write-disabled' }, head)
        return
      }
      const result = route.endsWith('/tasks/update')
        ? await updateTask(resolved.root, body)
        : route.endsWith('/tasks/schedule')
          ? await scheduleTask(resolved.root, body)
          : route.endsWith('/tasks/add')
            ? await addTask(resolved.root, body, config)
            : await toggleTask(resolved.root, body)
      const badRequest = new Set(['not-a-task', 'line-out-of-range', 'bad-text', 'text-too-long', 'bad-time', 'bad-date'])
      const status = result.ok ? 200 : (result.error === 'stale' ? 409 : (badRequest.has(result.error) ? 400 : 200))
      sendJson(res, status, { ...result, root: resolved.root }, head)
      return
    }

    /* ── 安装向导：/setup（GET 查状态并可自动发现，POST 保存路径）─────────── */
    if (route.endsWith('/setup')) {
      const resolved = await resolveRoot(refs, config, url)

      if (req.method === 'POST') {
        const blocked = writeGuard(req)
        if (blocked) {
          sendJson(res, 403, { ok: false, error: blocked }, head)
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'bad-body', message: String((error && error.message) || error) }, head)
          return
        }
        const checked = await validateRootPath(body.root)
        if (checked.error) {
          sendJson(res, 400, { ok: false, ...checked }, head)
          return
        }
        const next = await writeConfigRoot(checked.root)
        sendJson(res, 200, { ok: true, root: checked.root, roots: next.roots }, head)
        return
      }

      const wantDetect = url.searchParams.get('detect') === '1' || resolved.error !== undefined
      const detected = wantDetect ? await detectVaults() : []
      sendJson(res, 200, {
        ok: true,
        configured: resolved.error === undefined,
        needsSetup: resolved.error !== undefined,
        root: resolved.error ? null : resolved.root,
        rootSource: resolved.error ? null : resolved.source,
        roots: config.roots,
        autoOpen: config.autoOpen !== false,
        detected,
        hint: resolved.error
          ? '还没配置 Obsidian 日记文件夹：填一个路径，或点「自动寻找」让插件在本机找 Obsidian vault。'
          : null,
      }, head)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'dsh-calendar: only GET/HEAD is served here\n', 'text/plain; charset=utf-8')
      return
    }

    /* ── /tasks ─────────────────────────────────────────────────────────── */
    if (route.endsWith('/tasks')) {
      const resolved = await resolveRoot(refs, config, url)
      if (resolved.error) {
        sendJson(res, 200, {
          ok: false, error: resolved.error, asked: resolved.asked || null, allowed: resolved.allowed || [],
          needsSetup: resolved.error === 'no-workspace',
          hint: resolved.error === 'no-workspace' ? '还没配置 Obsidian 日记文件夹：在右侧栏面板里填一个路径即可开始。' : null,
          tasks: [], buckets: {}, notes: {},
          capabilities: { write: false, create: false, appendDoneDate: true, schedule: false, add: false },
        }, head)
        return
      }
      const refresh = url.searchParams.get('refresh') === '1'
      try {
        const { payload, cached } = await cachedScan(resolved.root, refresh)
        sendJson(res, 200, {
          ok: true,
          root: payload.root,
          rootSource: resolved.source,
          scanned: payload.scanned,
          counts: payload.counts,
          tasks: payload.tasks,
          buckets: payload.buckets,
          notes: payload.notes,
          cached,
          generatedAt: new Date().toISOString(),
          capabilities: {
            write: !(config.write && config.write.enabled === false),
            create: !(config.create && config.create.enabled === false),
            appendDoneDate: !(config.write && config.write.appendDoneDate === false),
            schedule: !(config.write && config.write.enabled === false),
            add: !(config.write && config.write.enabled === false),
          },
          dayPlanner: config.dayPlanner || DEFAULT_CONFIG.dayPlanner,
          calendar: config.calendar || DEFAULT_CONFIG.calendar,
        }, head)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'scan-failed', message: String((error && error.message) || error) }, head)
      }
      return
    }

    /* ── /status ────────────────────────────────────────────────────────── */
    if (route.endsWith('/status')) {
      let pageBytes = null
      let pageError = null
      try {
        pageBytes = (await readFile(PAGE_URL)).byteLength
      } catch (error) {
        pageError = String((error && error.message) || error)
      }
      const resolved = await resolveRoot(refs, config, url)
      const writable = []
      for (const candidate of config.roots) {
        const dir = await realDir(candidate)
        if (!dir) { writable.push({ path: candidate, state: 'missing' }); continue }
        let state = 'read-only'
        try {
          await access(dir, constants.W_OK)
          state = 'writable'
        } catch { /* 只读 */ }
        writable.push({ path: dir, state })
      }
      sendJson(res, 200, {
        plugin: name,
        page: ROUTE_PREFIX + '/preview',
        pageBytes,
        pageError,
        tasksRoute: ROUTE_PREFIX + '/tasks',
        toggleRoute: ROUTE_PREFIX + '/tasks/toggle',
        createRoute: ROUTE_PREFIX + '/notes/create',
        configPath: configPath(),
        configuredRoots: writable,
        write: config.write,
        create: config.create,
        autoOpen: config.autoOpen !== false,
        setup: {
          configured: resolved.error === undefined,
          root: resolved.error ? null : resolved.root,
          roots: config.roots,
          route: ROUTE_PREFIX + '/setup',
        },
        allowAnyRoot: config.allowAnyRoot === true,
        workspace: resolved.error ? { error: resolved.error, allowed: resolved.allowed || [] } : { root: resolved.root, source: resolved.source },
        clientModule: clientModuleState(refs.clientModules),
        scheduledRoute: ROUTE_PREFIX + '/tasks/schedule',
        addRoute: ROUTE_PREFIX + '/tasks/add',
        standalone: PAGE_URL.pathname,
      }, head)
      return
    }

    /* ── 其余 = 日历页 ──────────────────────────────────────────────────── */
    try {
      const html = await readFile(PAGE_URL)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(html.byteLength),
        'cache-control': 'no-store',
      })
      res.end(head ? undefined : html)
    } catch (error) {
      sendText(res, 500, [
        'dsh-calendar: cannot read the calendar page.',
        'expected: ' + PAGE_URL.pathname,
        'reason:   ' + String((error && error.message) || error),
        'hint:     keep <plugin>/standalone/calendar.html next to <plugin>/lib/, or re-inject the package.',
        '',
      ].join('\n'), 'text/plain; charset=utf-8')
    }
  }
}

/**
 * 插件体：所有服务都按"到货即用"注入，缺谁也不影响插件本体装配。
 * 注意：cordis 禁止在未声明注入的情况下触碰服务，所以一律走 ctx.inject 回调，不做探测。
 *
 * @param {import('cordis').Context} ctx - host 根上下文
 * @param {object} [config] - loader 行配置（文件配置优先级更高）
 */
export function apply(ctx, config = {}) {
  const refs = { clientModules: null, sessions: null, workspaces: null }
  ctx.inject(['clientModules'], (moduleCtx) => { refs.clientModules = moduleCtx.clientModules })
  ctx.inject(['sessions'], (sessionCtx) => { refs.sessions = sessionCtx.sessions })
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => { refs.workspaces = workspaceCtx.workspaceRegistry })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(refs, config),
      }),
      'dsh-calendar: routes',
    )
    webCtx.logger?.info?.('[dsh-calendar] 路由：%s/preview · %s/tasks · %s/tasks/toggle · %s/notes/create · %s/status',
      ROUTE_PREFIX, ROUTE_PREFIX, ROUTE_PREFIX, ROUTE_PREFIX, ROUTE_PREFIX)
  })
}
