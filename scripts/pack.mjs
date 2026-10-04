/**
 * pack.mjs — 把插件同步到独立交付目录并打成可分发的 npm 包
 *
 * 用法：
 *   node scripts/pack.mjs                同步 + 全量回归 + npm pack
 *   node scripts/pack.mjs --dry          只同步与回归，不打包
 *   node scripts/pack.mjs --no-test      跳过回归（快，但别在发布时用）
 *
 * 产出（默认写到 ../dsh-calendar-plugin/）：
 *   dsh-calendar-plugin/<包内容>           ← 独立交付目录（生成物，别手改）
 *   dsh-calendar-plugin/dist/dsh-calendar-<version>.tgz
 *
 * 交付目录是**生成物**：源始终是 D:\what's_today\dsh-calendar（已装进 profile 的那份）。
 * 所以改代码只改源，然后重跑本脚本。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..')
/**
 * 两种运行形态：
 *  · 工作区形态：源在 `dsh-calendar/`，同步到兄弟目录 `dsh-calendar-plugin/`（默认）
 *  · 仓库形态：脚本就跑在 `dsh-calendar-plugin/` 里（GitHub 仓库即该目录）→ 原地跑测试、打到 ./dist
 */
const repoMode = basename(source) === 'dsh-calendar-plugin'
const target = repoMode
  ? source
  : (process.argv.includes('--target')
    ? process.argv[process.argv.indexOf('--target') + 1]
    : join(source, '..', 'dsh-calendar-plugin'))
const dry = process.argv.includes('--dry')
const skipTests = process.argv.includes('--no-test')

const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const COPY = ['lib', 'standalone', 'scripts', 'cordis.patch.yml', 'README.md', 'DEVELOPMENT.md', 'LICENSE', 'CHANGELOG.md', 'package.json']
const ALWAYS_IGNORE = new Set(['node_modules', '.git', 'dist', 'verify', '.setup-probe'])

function log(message) {
  console.log(message)
}

/* ── 0. 防覆盖闸 ────────────────────────────────────────────────────────────
 * 2026-10-04 的真实事故（发生两次）：在工作区形态下跑本脚本，它会把 `dsh-calendar/`（源）
 * 整份同步到 `dsh-calendar-plugin/`（目标），而目标**正是 git 仓库** —— 于是刚提交的脱敏文档、
 * 版本号与新加的检查被旧副本盖掉。仓库是公开产物，绝不能被当成"生成物"覆盖。
 * 规则：目标里若有 .git，工作区模式直接拒绝；确实要覆盖得显式加 --force。 */
if (!repoMode && existsSync(join(target, '.git')) && !process.argv.includes('--force')) {
  throw new Error(`防覆盖闸：目标 ${target} 是一个 git 仓库，工作区模式会把它当生成物整份覆盖。\n` +
    '  仓库形态：直接在该仓库目录里跑本脚本（原地跑测试并打到 ./dist）。\n' +
    '  确实要覆盖：加 --force 明确表示知情。')
}
log('  ✓ 防覆盖闸：目标不是 git 仓库（或已显式 --force）')

/* ── 1. 同步到独立交付目录（先清掉旧的代码目录，保证没有残留）─────────────── */
log(`源   ：${source}`)
log(`目标 ：${target}${repoMode ? '（仓库形态：原地打包）' : ''}`)
mkdirSync(target, { recursive: true })
for (const name of (repoMode ? [] : COPY)) {
  if (name === 'dist') continue
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(from)) { log(`  · 跳过不存在的 ${name}`); continue }
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, filter: (src) => !ALWAYS_IGNORE.has(src.split(/[\\/]/).pop()) })
  log(`  ✓ ${name}`)
}

/* ── 2. 工作区形态：在交付目录里放一份"这是生成物"的说明（仓库形态不需要） ──────── */
if (!repoMode) writeFileSync(join(target, 'GENERATED.md'), [
  '# 这是生成目录（别直接改）',
  '',
  `由 \`${relative(target, join(source, 'scripts', 'pack.mjs')).replace(/\\/g, '/')}\` 生成。`,
  '',
  `- 源（也是当前装进 DSH 的那份）：\`${source}\``,
  `- 重新生成：\`node "${join(source, 'scripts', 'pack.mjs')}"\``,
  `- 打包产物：\`dist/dsh-calendar-${pkg.version}.tgz\``,
  '',
].join('\n'), 'utf8')
log('  ✓ GENERATED.md')

/* ── 3. 全量回归（发布前必须绿）────────────────────────────────────────────── */
if (!skipTests) {
  const suites = ['tasks-parse.test.mjs', 'tasks-render.test.mjs', 'fit-logic.test.mjs', 'auto-open.test.mjs', 'setup.test.mjs']
  let total = 0
  for (const suite of suites) {
    const out = execFileSync(process.execPath, [join(target, 'scripts', suite)], { encoding: 'utf8' })
    const last = out.trim().split('\n').filter((l) => /checks passed/.test(l)).pop() || ''
    if (last.includes('FAIL') || /(\d+)\/(\d+)/.test(last) === false) throw new Error(`${suite} 未全绿：${last}`)
    const [, pass, all] = /(\d+)\/(\d+) checks passed/.exec(last) || []
    if (pass !== all) throw new Error(`${suite} 未全绿：${last}`)
    total += Number(all)
    log(`  ✓ ${suite}  ${last}`)
  }
  log(`  → 回归合计 ${total} 项断言全绿`)
}

/* ── 4. 体积守卫 ───────────────────────────────────────────────────────────
 * 硬约束：交付 gate 切文件头 64KB 做严格 UTF-8 解码，那 64KB 必须解得出。
 * 总上限 90KiB 是本项目自加的防膨胀闸（加皮肤后从 64KB 放宽），不是外部要求。
 * 这里用 Buffer.byteLength 而不是 String.length：后者数的是 UTF-16 码元，
 * 遇到非 BMP 字符（emoji 等）会和真实字节数分歧。 */
const page = readFileSync(join(target, 'standalone', 'calendar.html'))
const pageBytes = page.byteLength
const HARD_HEAD = 65536
const CEILING = 92160 /* 90 KiB */
if (pageBytes >= CEILING) throw new Error(`calendar.html 体积 ${pageBytes} ≥ ${CEILING}，先跑 scripts/slim-page.mjs`)
let headOk = true
try { new TextDecoder('utf-8', { fatal: true }).decode(page.subarray(0, HARD_HEAD)) } catch { headOk = false }
if (!headOk) throw new Error('calendar.html 头部 64KB 切片不是合法 UTF-8：交付 gate 会拒收')
log(`  ✓ 页面体积 ${pageBytes} B < ${CEILING}，头 64KB 切片是合法 UTF-8`)

/* ── 5. 隐私闸（发布前必过）─────────────────────────────────────────────────
 * 背景：v1.0.0 / v1.1.0 的包里曾混进个人目录名与真实待办文本，已脱敏重建。
 * 这里把"不许再发生"变成一条会**让打包失败**的检查，而不是靠人记得。
 *
 * 规则刻意不硬编码任何具体人名或目录名 —— 否则检查本身就变成泄露：
 *   a) 绝对用户目录 `X:\Users\<真实用户名>\…`：`<user>` / `%USERNAME%` / `me` 等占位符放行
 *   b) `PRIVACY_TERMS` 环境变量里逗号分隔的词：发布前用它扫真实 vault 目录名、真实待办短语，
 *      **不必也不该**写进仓库。例：set PRIVACY_TERMS=我的日记目录,某条真实待办
 *   c) 扫描器自身跳过（否则规则文本里的示例会自匹配）
 */
const SCAN_EXT = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.html', '.txt'])
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist'])
function walkText(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_SKIP.has(entry.name) || entry.name === 'pack.mjs') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkText(full, out)
    else if (SCAN_EXT.has(extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}
const PLACEHOLDER = /^(<[^>]+>|%USERNAME%|you|me|example|user)$/i
const findings = []
const extraTerms = (process.env.PRIVACY_TERMS || '').split(',').map((v) => v.trim()).filter(Boolean)
const scanned = walkText(target)
for (const file of scanned) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(target, file).split('\\').join('/')
  for (const m of text.matchAll(/\b[A-Za-z]:\\+Users\\+([^\\\s"'`]+)/g)) {
    if (!PLACEHOLDER.test(m[1])) findings.push(rel + ': 绝对用户目录 ' + m[0])
  }
  for (const term of extraTerms) if (text.includes(term)) findings.push(rel + ': 命中 PRIVACY_TERMS 词 ' + term)
}
if (findings.length > 0) {
  for (const f of findings.slice(0, 20)) log('    x ' + f)
  throw new Error('隐私闸拦下 ' + findings.length + ' 处疑似个人信息：先脱敏再打包（占位符写成 <user> / me）')
}
log('  ✓ 隐私闸：' + scanned.length + ' 个文本文件无真实用户目录' + (extraTerms.length ? '，且未命中 PRIVACY_TERMS 的 ' + extraTerms.length + ' 个词' : '（未提供 PRIVACY_TERMS）'))

if (dry) { log('\n--dry：已同步，未打包'); process.exit(0) }

/* ── 5. npm pack ───────────────────────────────────────────────────────────── */
const dist = join(target, 'dist')
mkdirSync(dist, { recursive: true })
for (const file of readdirSync(dist)) if (file.endsWith('.tgz')) rmSync(join(dist, file), { force: true })
// --json + --loglevel=error：机器可读、且不让 npm 的 notice 走 stderr（否则 Windows 上退出码会被带成 1）
// Windows 上 npm 是 .cmd，Node 24 要求 shell:true 才能 spawn（会有一条 DEP0190 警告，无副作用）
const packOut = execFileSync('npm', ['pack', '--json', '--loglevel=error', '--pack-destination', dist],
  { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
const [info] = JSON.parse(packOut)
const packed = info.filename
const tgz = join(dist, packed)
log(`\n✓ 打包完成：${tgz}`)
log(`  大小：${(statSync(tgz).size / 1024).toFixed(1)} KB`)
log(`  安装：dsh plugin --profile web add "${tgz}"`)
