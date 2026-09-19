/**
 * setup.test.mjs — 安装向导与自动发现的回归（不需要浏览器，也不需要 Obsidian）
 *
 * 两侧都测真代码：
 *   · host 侧：import lib/index.js 的 __setup（解析 Daily Notes 配置、日期格式归类、路径校验）
 *   · client 侧：抽取 lib/client.js 的「安装向导」标记块（错误文案、候选摘要）
 * 另外做静态接线检查：向导必须带写标头、必须走 /setup 路由、必须能自动寻找。
 *
 * 用法：node scripts/setup.test.mjs [reportPath]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { __setup } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const hostSource = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

/* ── client 侧：向导文案（纯函数） ──────────────────────────────────────────── */
const BEGIN = '// #region 安装向导'
const END = '// #endregion'
const from = clientSource.indexOf(BEGIN)
const to = clientSource.indexOf(END, from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能在 lib/client.js 里找到「安装向导」标记块')
  process.exit(1)
}
const { setupErrorText, candidateSummary } = new Function(`${clientSource.slice(from + BEGIN.length, to)}
  return { setupErrorText, candidateSummary }`)()

check('错误文案：路径不存在', /不存在/.test(setupErrorText({ error: 'not-a-directory' })), true)
check('错误文案：太宽的目标', /整块盘|系统目录/.test(setupErrorText({ error: 'too-broad' })), true)
check('错误文案：空路径', /填写/.test(setupErrorText({ error: 'empty-path' })), true)
check('错误文案：缺写标头（说明是权限问题）', /写标头/.test(setupErrorText({ error: 'missing-write-header' })), true)
check('错误文案：未知错误带原文', setupErrorText({ error: 'boom' }), '保存失败：boom')
check('错误文案：null 不炸', setupErrorText(null), '保存失败')
check('候选摘要：配置了 Daily Notes', candidateSummary({ hasDailyConfig: true, dailyFolder: '日记', dateFormat: 'YYYY-MM-DD' }),
  'Daily Notes：日记 · YYYY-MM-DD')
check('候选摘要：没配 Daily Notes 时说明兜底用 vault 根', candidateSummary({ hasDailyConfig: false, dateFormat: 'YYYY-MM-DD' }), '未配置 Daily Notes（用 vault 根） · YYYY-MM-DD')
check('候选摘要：装了 Day Planner / Calendar 会标出来',
  candidateSummary({ hasDailyConfig: false, dateFormat: 'YYYY-MM-DD', dayPlanner: { installed: true }, calendar: { installed: true } }),
  '未配置 Daily Notes（用 vault 根） · YYYY-MM-DD · 有 Day Planner · 有 Calendar')
check('候选摘要：空候选给空串', candidateSummary(null), '')

/* ── host 侧：Daily Notes 配置解析与日期格式归类 ───────────────────────────── */
check('解析 Daily Notes：folder + format',
  __setup.parseDailyNotesConfig({ folder: '日历&备忘录', format: 'YYYY-MM-DD' }),
  { folder: '日历&备忘录', format: 'YYYY-MM-DD' })
check('解析 Daily Notes：缺 format → 默认', __setup.parseDailyNotesConfig({ folder: 'diary' }).format, 'YYYY-MM-DD')
check('解析 Daily Notes：脏输入不炸', __setup.parseDailyNotesConfig(null), { folder: '', format: 'YYYY-MM-DD' })
check('日期格式归类：横杠', __setup.dateFormatFor('YYYY-MM-DD'), 'YYYY-MM-DD')
check('日期格式归类：点分隔', __setup.dateFormatFor('YYYY.MM.DD'), 'YYYY.MM.DD')
check('日期格式归类：中文', __setup.dateFormatFor('YYYY年MM月DD日'), 'YYYY年M月D日')
check('日期格式归类：紧凑', __setup.dateFormatFor('YYYYMMDD'), 'YYYYMMDD')
check('候选父目录包含 Documents 与用户主目录', (() => {
  const parents = __setup.candidateParents()
  return parents.some((p) => /Documents$/.test(p)) && parents.length >= 4
})(), true)

/* ── host 侧：路径校验（真跑文件系统） ─────────────────────────────────────── */
const probe = join(here, '..', '.setup-probe')   // 故意不用 os.tmpdir()：Windows 的临时目录在 AppData 下，会被 too-broad 正确拒掉
mkdirSync(probe, { recursive: true })
{
  const ok = await __setup.validateRootPath(probe)
  check('合法目录通过校验（返回真实路径）', ok.root && ok.root.length > 0, true)
  check('不存在的路径被拒', (await __setup.validateRootPath(join(probe, 'nope-nope'))).error, 'not-a-directory')
  check('空路径被拒', (await __setup.validateRootPath('   ')).error, 'empty-path')
  check('带引号的路径也能认（用户常直接粘贴）', Boolean((await __setup.validateRootPath('"' + probe + '"')).root), true)
  const broad = await __setup.validateRootPath(process.platform === 'win32' ? 'C:\\' : '/')
  check('整块盘被拒（避免全盘扫描+写回）', broad.error, 'too-broad')
  check('用户主目录本身被拒', (await __setup.validateRootPath(process.env.USERPROFILE || process.env.HOME)).error, 'too-broad')
}
rmSync(probe, { recursive: true, force: true })

/* ── host 侧：DSH 家目录解析（AI 常在没设 DSH_HOME 的 shell 里跑）───────────── */
{
  const info = await __setup.dshHomeInfo()
  check('dshHomeInfo 形状', typeof info.home === 'string' && ['env', 'fallback'].includes(info.source) && typeof info.looksLikeDshHome === 'boolean', true)
  check('dshHomeInfo 与 configPath 同源', __setup.configPath().startsWith(info.home), true)
}

/* ── 真跑 CLI：JSON 输出 + DSH_HOME 覆盖（AI 的用法）────────────────────────── */
{
  const fakeHome = join(here, '..', '.setup-probe-home')
  mkdirSync(fakeHome, { recursive: true })
  const cli = join(here, 'setup.mjs')
  const run = (args, env) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }))
  const withHome = run(['--print', '--json'], { DSH_HOME: fakeHome })
  check('CLI --print --json 会报出 DSH 家目录与来源', [withHome.dshHomeSource, withHome.dshHome.startsWith(fakeHome)], ['env', true])
  check('CLI 按 DSH_HOME 解析配置文件路径', withHome.configPath.startsWith(fakeHome), true)
  const detected = run(['--detect', '--json'], { DSH_HOME: fakeHome })
  check('CLI --detect --json 返回数组（AI 可直接解析）', Array.isArray(detected.detected) && typeof detected.count === 'number', true)
  rmSync(fakeHome, { recursive: true, force: true })
}

/* ── 静态接线：向导路由 + 写标头 + 自动寻找 ────────────────────────────────── */
check('host 暴露 /setup 路由', /route\.endsWith\('\/setup'\)/.test(hostSource), true)
check('host 在未配置时返回 needsSetup', /needsSetup: resolved\.error === 'no-workspace'/.test(hostSource), true)
check('host 的 /setup 写操作也要写标头', /route\.endsWith\('\/setup'\)[\s\S]{0,600}?writeGuard\(req\)[\s\S]{0,1200}?writeConfigRoot/.test(hostSource), true)
check('host 导出给 AI 用的 __setup 接口', /export const __setup = \{/.test(hostSource) && /detectVaults,/.test(hostSource), true)
check('client 面板先查 setup 再决定挂 iframe',
  /fetch\('\/dsh-calendar\/setup'/.test(clientSource) && /data\.configured === false \? 'setup' : 'ready'/.test(clientSource), true)
check('client 向导会保存路径并带写标头',
  /x-dsh-calendar': 'write'/.test(clientSource) && /JSON\.stringify\(\{ root: value \}\)/.test(clientSource), true)
check('client 打开向导就自动找一次', /React\.useEffect\(\(\) => \{ probe\(\) \}, \[probe\]\)/.test(clientSource), true)
check('向导里提到让 AI 代配的接口', /scripts\/setup\.mjs --detect/.test(clientSource), true)
check('向导样式齐备', /\.dsh-calendar-setup\{/.test(clientSource) && /\.dsh-calendar-setup-primary\{/.test(clientSource), true)

const failed = results.filter((r) => !r.ok)
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ source: 'lib/index.js#__setup + lib/client.js#安装向导', results }, null, 2) + '\n')
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
