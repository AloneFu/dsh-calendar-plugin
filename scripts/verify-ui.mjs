/**
 * verify-ui.mjs — 单文件日历页的无头验收（本机 Chrome/Edge + CDP，零 npm 依赖）
 *
 * 做三件事：
 *   1. DOM 断言：大标题 / 七列 42 格 / 周一起始 / 今日默认选中 / 非当月弱化 /
 *      无边框无阴影 / 选中态是 iOS 蓝圆形 / 选中日期与系统今天一致
 *   2. 交互断言：点箭头切月 · 点某天改写选中 · 鼠标横向拖拽（滑动手势）切月 · 键盘 ←→
 *   3. 视觉留证：浅色 / 深色（走 prefers-color-scheme 媒体查询）/ 手势后 / 深色选中 —— 逐张 PNG
 *
 * 用法：
 *   node scripts/verify-ui.mjs [url] [outDir]
 *   CHROME_PATH=... node scripts/verify-ui.mjs
 *
 * 退出码：0 = 全部硬断言通过；1 = 有断言失败（细节见 outDir/report.json）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const URL_BASE = process.argv[2] || 'http://127.0.0.1:3080/dsh-calendar/preview'
const OUT_DIR = process.argv[3] || 'verify'
const PORT = 9300 + Math.floor(Math.random() * 500)

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const results = []
const shots = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + detail}`)
}

/* ── 极简 CDP 客户端（Node 24 自带全局 WebSocket） ───────────────────────────── */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.waiting = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const slot = this.waiting.get(msg.id)
        if (!slot) return
        this.waiting.delete(msg.id)
        if (msg.error) slot.reject(new Error(msg.error.message))
        else slot.resolve(msg.result)
        return
      }
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params)
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, 30000)
    })
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.listeners.get(method) || []
      const fn = (params) => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((f) => f !== fn))
        resolve(params)
      }
      list.push(fn)
      this.listeners.set(method, list)
    })
  }

  close() { try { this.ws.close() } catch {} }
}

/* ── 启动浏览器 ─────────────────────────────────────────────────────────────── */
function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      if (p && existsSync(p)) return p
    } catch {}
  }
  return null
}

const profileDir = join(tmpdir(), `dsh-calendar-verify-${Date.now()}`)
mkdirSync(profileDir, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const browser = findBrowser()
if (!browser) {
  console.error('No Chrome/Edge found; set CHROME_PATH')
  process.exit(1)
}
console.log('browser:', browser)

const child = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=560,820',
  'about:blank',
], { stdio: 'ignore' })

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('CDP endpoint never came up')
}

const page = await targets()
const cdp = await Cdp.connect(page.webSocketDebuggerUrl)

try {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 560, height: 820, deviceScaleFactor: 2, mobile: false,
  })

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 60))
    return r.result.value
  }

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(OUT_DIR, name + '.png')
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
    console.log('shot:', file)
    return file
  }

  const navigate = async (url) => {
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    await sleep(250)
  }

  const SNAPSHOT = `(() => {
    const grid = document.getElementById('calGrid')
    const cells = Array.from(grid.querySelectorAll('.cal-day'))
    const selected = grid.querySelector('.cal-day.is-selected')
    const todayCell = grid.querySelector('.cal-day.is-today')
    const card = document.querySelector('.cal')
    const cs = getComputedStyle(card)
    const num = selected ? getComputedStyle(selected.querySelector('.cal-day-num')) : null
    const outsideCell = grid.querySelector('.cal-day.is-outside')
    return {
      title: document.getElementById('calTitle').textContent,
      subtitle: document.getElementById('calSubtitle').textContent,
      weekdays: Array.from(document.querySelectorAll('.cal-weekday')).map((e) => e.textContent).join(''),
      cells: cells.length,
      firstCellLabel: cells[0] ? cells[0].getAttribute('aria-label') : null,
      selected: selected ? selected.dataset.date : null,
      today: todayCell ? todayCell.dataset.date : null,
      outsideCount: grid.querySelectorAll('.cal-day.is-outside').length,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      cardBg: cs.backgroundColor,
      cardRadius: cs.borderTopLeftRadius,
      cardBorder: cs.borderTopWidth,
      cardShadow: cs.boxShadow,
      selBg: num ? num.backgroundColor : null,
      selColor: num ? num.color : null,
      selRadius: num ? num.borderRadius : null,
      selW: num ? num.width : null,
      selH: num ? num.height : null,
      todayColor: todayCell ? getComputedStyle(todayCell.querySelector('.cal-day-num')).color : null,
      todaySelected: Boolean(todayCell && todayCell.classList.contains('is-selected')),
      outsideOpacity: outsideCell ? getComputedStyle(outsideCell).opacity : null,
      pageBg: getComputedStyle(document.body).backgroundColor,
      ink: cs.color,
      font: cs.fontFamily,
      theme: document.documentElement.dataset.calTheme,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })()`

  const localTodayKey = (() => {
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })()

  /* ── 1. 浅色（显式 ?theme=light） ─────────────────────────────────────────── */
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await navigate(URL_BASE + '?theme=light')
  const light = await evaluate(SNAPSHOT)
  await shot('01-light')

  check('42 格 / 7 列网格', light.cells === 42 && light.columns === 7, `cells=${light.cells} cols=${light.columns}`)
  check('星期表头 = 一二三四五六日（周一起始）', light.weekdays === '一二三四五六日', light.weekdays)
  check('首格为星期一', /星期一$/.test(light.firstCellLabel || ''), light.firstCellLabel)
  check('默认选中今天', light.selected === localTodayKey, `selected=${light.selected} today=${localTodayKey}`)
  check('今天同时带 is-today 且被选中', light.today === light.selected && light.todaySelected === true,
    `today=${light.today} selected=${light.todaySelected}`)
  check('选中态为 iOS 蓝 #007AFF 圆形', light.selBg === 'rgb(0, 122, 255)' &&
    light.selRadius === '50%' && light.selW === light.selH,
    `${light.selBg} ${light.selW}×${light.selH} radius=${light.selRadius}`)
  check('圆角卡片', parseFloat(light.cardRadius) >= 16, light.cardRadius)
  check('零边框 / 零阴影', parseFloat(light.cardBorder) === 0 && /none/.test(light.cardShadow),
    `border=${light.cardBorder} shadow=${light.cardShadow}`)
  check('非当月日期弱化（opacity < 0.4）', Number(light.outsideOpacity) < 0.4 && light.outsideCount > 0,
    `opacity=${light.outsideOpacity} count=${light.outsideCount}`)
  check('大标题 = 年/月', /^\d{4}年\d{1,2}月$/.test(light.title), light.title)
  check('字体栈以 -apple-system 起', /-apple-system/.test(light.font), light.font.slice(0, 48))
  check('无横向溢出', light.scrollW <= light.clientW + 1, `${light.scrollW} <= ${light.clientW}`)

  /* ── 2. 交互：点击某天 ────────────────────────────────────────────────────── */
  const clickDay = async (index) => {
    const box = await evaluate(`(() => {
      const c = document.querySelectorAll('#calGrid .cal-day')[${index}]
      const r = c.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, date: c.dataset.date }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await sleep(200)
    return box.date
  }

  const midIndex = 20
  const clicked = await clickDay(midIndex)
  const afterClick = await evaluate(SNAPSHOT)
  await shot('02-light-pick-day')
  check('点击某天 → 高亮该日期', afterClick.selected === clicked, `${clicked} → ${afterClick.selected}`)
  check('选中移到别处后今天转为红字（iOS 惯例）', afterClick.todayColor === 'rgb(255, 59, 48)' && afterClick.todaySelected === false,
    `${afterClick.todayColor}`)
  check('「今天」按钮在有偏离时出现', await evaluate(`!document.getElementById('calTodayBtn').hidden`), '')

  /* ── 3. 交互：箭头切月 ────────────────────────────────────────────────────── */
  const beforeArrow = afterClick.title
  await evaluate(`document.getElementById('calNext').click()`)
  await sleep(250)
  const afterArrow = await evaluate(SNAPSHOT)
  await shot('03-light-next-month')
  check('点箭头 → 切到下一个月', afterArrow.title !== beforeArrow, `${beforeArrow} → ${afterArrow.title}`)
  const clickedLabel = `${Number(clicked.slice(5, 7))}月${Number(clicked.slice(8, 10))}日`
  check('切月后选中日期保持不变（标题下说明仍是它）', afterArrow.subtitle.includes(clickedLabel),
    `subtitle=${afterArrow.subtitle}`)

  await evaluate(`document.getElementById('calPrev').click()`)
  await sleep(250)
  const backArrow = await evaluate(SNAPSHOT)
  check('往回切回到原月', backArrow.title === beforeArrow, backArrow.title)

  /* ── 4. 交互：鼠标横向拖拽（滑动手势，阈值 48px） ─────────────────────────── */
  const beforeSwipe = backArrow.title
  const box = await evaluate(`(() => { const r = document.getElementById('calGrid').getBoundingClientRect()
    return { x: r.left + r.width * 0.75, y: r.top + r.height * 0.5 } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  for (const dx of [20, 50, 90, 130]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - dx, y: box.y, button: 'left', buttons: 1 })
    await sleep(25)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x - 130, y: box.y, button: 'left', buttons: 0 })
  await sleep(320)
  const afterSwipe = await evaluate(SNAPSHOT)
  await shot('04-light-after-swipe')
  check('手势左滑 → 前进一个月', afterSwipe.title !== beforeSwipe, `${beforeSwipe} → ${afterSwipe.title}`)
  check('滑动手势没有误触发日期选中', afterSwipe.subtitle.includes(clickedLabel), `subtitle=${afterSwipe.subtitle}`)

  /* ── 5. 键盘 ←→ ───────────────────────────────────────────────────────────── */
  const beforeKey = afterSwipe.title
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 })
  await sleep(250)
  check('键盘 ← 切回上一个月', (await evaluate(SNAPSHOT)).title !== beforeKey, '')

  await evaluate(`document.getElementById('calTodayBtn').click()`)
  await sleep(200)
  const afterToday = await evaluate(SNAPSHOT)
  check('「今天」按钮回到今天并选中', afterToday.selected === localTodayKey && afterToday.todaySelected === true, afterToday.selected)

  /* ── 6. 深色：走 prefers-color-scheme（auto 主题） ─────────────────────────── */
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await navigate(URL_BASE)
  const dark = await evaluate(SNAPSHOT)
  await shot('05-dark-auto')
  check('系统深色 → 深色令牌生效（theme=auto）', dark.theme === 'auto' && dark.pageBg === 'rgb(0, 0, 0)',
    `theme=${dark.theme} pageBg=${dark.pageBg}`)
  check('深色下卡片/文字反转', dark.cardBg === 'rgb(28, 28, 30)' && /255, 255, 255/.test(dark.ink),
    `${dark.cardBg} / ${dark.ink}`)
  check('深色下选中态仍是 iOS 蓝', dark.selBg === 'rgb(0, 122, 255)', dark.selBg)

  /* ── 7. 强制的深色 + 内嵌形态 ─────────────────────────────────────────────── */
  await navigate(URL_BASE + '?embed=1&theme=dark')
  const embed = await evaluate(`(() => {
    const card = document.querySelector('.cal')
    return {
      embed: document.documentElement.classList.contains('cal-embed'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      radius: getComputedStyle(card).borderTopLeftRadius,
      maxWidth: getComputedStyle(card).maxWidth,
      title: document.getElementById('calTitle').textContent,
    }
  })()`)
  await shot('06-embed-dark')
  check('?embed=1 生效：透明底 / 去卡片外观', embed.embed === true && /rgba\(0, 0, 0, 0\)/.test(embed.bodyBg) &&
    parseFloat(embed.radius) === 0 && embed.maxWidth === 'none',
    `bodyBg=${embed.bodyBg} radius=${embed.radius} maxWidth=${embed.maxWidth}`)

  /* ── 8. 无外部请求（资源检查） ────────────────────────────────────────────── */
  await navigate(URL_BASE + '?theme=light')
  const resources = await evaluate(`performance.getEntriesByType('resource').map((r) => r.name)`)
  const external = resources.filter((u) => !u.startsWith(URL_BASE.split('/dsh-calendar')[0]))
  check('零外部资源请求', external.length === 0, `resources=${resources.length} external=${external.length}`)
} finally {
  cdp.close()
  try { child.kill() } catch {}
  await sleep(200)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}

const failed = results.filter((r) => !r.ok)
writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ url: URL_BASE, results, shots }, null, 2) + '\n')
console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots: ${shots.length}`)
process.exit(failed.length === 0 ? 0 : 1)
