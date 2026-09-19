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
import { basename, dirname, join, relative } from 'node:path'
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

/* ── 4. 体积守卫（交付 gate 会切 64KB 头做 UTF-8 校验）────────────────────── */
const page = readFileSync(join(target, 'standalone', 'calendar.html'))
if (page.length >= 65536) throw new Error(`calendar.html 体积 ${page.length} ≥ 65536，先跑 scripts/slim-page.mjs`)
log(`  ✓ 页面体积 ${page.length} B < 65536`)

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
