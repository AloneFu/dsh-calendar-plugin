/**
 * verify-ui.mjs — 单文件日历页的无头验收（本机 Chrome/Edge + CDP，零 npm 依赖）
 *
 * 做四件事：
 *   1. DOM 断言：大标题 / 七列 42 格 / 周一起始 / 今日默认选中 / 非当月弱化 /
 *      选中态是品红→靛紫渐变圆 / 泡泡渐变页底 / 磨砂光泽卡 / 铬面标题 / 装饰齐备 /
 *      color-scheme 跟随令牌 / 选中日期与系统今天一致
 *   2. 交互断言：点箭头切月 · 点某天改写选中 · 鼠标横向拖拽（滑动手势）切月 · 键盘 ←→
 *   3. 皮肤断言：三套皮肤（?skin=y2k|win95|cel）各自的视觉锚点，外加页内切换按钮——
 *      点一下换皮肤、不重载页面、刷新后仍记得（localStorage）
 *   4. 视觉留证：三套皮肤 × 浅/深 + 内嵌 —— 逐张 PNG
 *
 * ⚠️ 皮肤由 URL 参数与 localStorage 共同决定（?skin= 优先，否则读 localStorage），
 *    所以下面**每一条**导航都显式带 ?skin=：否则会被第 3 组交互断言写进
 *    localStorage 的皮肤串味，断言变成「看运气」。
 *
 * 外部请求：默认加载 1 个外链字体，且按皮肤只加载一套
 *          （y2k=Fredoka/Nunito，win95=VT323，cel=Baloo 2）；
 *          `?font=0` 关掉外链 → 回到「零外部请求」，离线可用。
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
      pageBgImage: getComputedStyle(document.body).backgroundImage,
      cardBgImage: cs.backgroundImage,
      cardBackdrop: cs.backdropFilter,
      selBgImage: num ? num.backgroundImage : null,
      titleBgImage: getComputedStyle(document.getElementById('calTitle')).backgroundImage,
      /* ── 皮肤轴 ── */
      skin: document.documentElement.dataset.calSkin,
      skinLabel: document.getElementById('calSkinBtn').textContent,
      skinTip: document.getElementById('calSkinBtn').getAttribute('aria-label'),
      titleTransform: getComputedStyle(document.getElementById('calTitle')).textTransform,
      titleColor: getComputedStyle(document.getElementById('calTitle')).color,
      titleFill: getComputedStyle(document.getElementById('calTitle')).webkitTextFillColor,
      dayBorder: cells[0] ? getComputedStyle(cells[0]).borderTopWidth + ' ' + getComputedStyle(cells[0]).borderTopStyle : null,
      dayRadius: cells[0] ? getComputedStyle(cells[0]).borderTopLeftRadius : null,
      weekdayColor: (() => { const w = document.querySelector('.cal-weekday'); return w ? getComputedStyle(w).color : null })(),
      ink: cs.color,
      font: cs.fontFamily,
      titleFont: getComputedStyle(document.getElementById('calTitle')).fontFamily,
      theme: document.documentElement.dataset.calTheme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
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
  await navigate(URL_BASE + '?skin=y2k&theme=light')
  const light = await evaluate(SNAPSHOT)
  await shot('01-light')

  check('42 格 / 7 列网格', light.cells === 42 && light.columns === 7, `cells=${light.cells} cols=${light.columns}`)
  check('星期表头 = 一二三四五六日（周一起始）', light.weekdays === '一二三四五六日', light.weekdays)
  check('首格为星期一', /星期一$/.test(light.firstCellLabel || ''), light.firstCellLabel)
  check('默认选中今天', light.selected === localTodayKey, `selected=${light.selected} today=${localTodayKey}`)
  check('今天同时带 is-today 且被选中', light.today === light.selected && light.todaySelected === true,
    `today=${light.today} selected=${light.todaySelected}`)
  check('选中态为品红→靛紫渐变圆形', /linear-gradient/.test(light.selBgImage || '') &&
    /255, 79, 216/.test(light.selBgImage) && /123, 92, 255/.test(light.selBgImage) &&
    light.selRadius === '50%' && light.selW === light.selH,
    `${light.selBgImage} ${light.selW}×${light.selH} radius=${light.selRadius}`)
  check('圆角泡泡卡（≥16px）', parseFloat(light.cardRadius) >= 16, light.cardRadius)
  check('泡泡渐变页底（粉→紫→婴儿蓝）', /linear-gradient/.test(light.pageBgImage) &&
    /255, 196, 228/.test(light.pageBgImage) && /165, 203, 255/.test(light.pageBgImage),
    (light.pageBgImage || '').slice(0, 70))
  check('卡片有光泽边 + 内发光', parseFloat(light.cardBorder) > 0 && /inset/.test(light.cardShadow),
    `border=${light.cardBorder} shadow=${(light.cardShadow || '').slice(0, 56)}`)
  check('卡片为磨砂玻璃（backdrop-filter）', /blur/.test(light.cardBackdrop), light.cardBackdrop)
  check('大标题为铬面（渐变 + 文字裁切）', /linear-gradient/.test(light.titleBgImage || ''),
    (light.titleBgImage || '').slice(0, 56))
  check('非当月日期弱化（opacity < 0.4）', Number(light.outsideOpacity) < 0.4 && light.outsideCount > 0,
    `opacity=${light.outsideOpacity} count=${light.outsideCount}`)
  check('大标题 = 年/月', /^\d{4}年\d{1,2}月$/.test(light.title), light.title)
  check('展示体 Fredoka / 正文 Nunito', /\bFredoka\b/.test(light.titleFont) && /\bNunito\b/.test(light.font),
    `${light.titleFont} | ${light.font.slice(0, 24)}`)
  check('装饰齐备（2 星 + 1 蝴蝶）', await evaluate(`(() => {
    const d = document.querySelector('.cal-deco')
    return Boolean(d) && d.querySelectorAll('i').length === 2 && d.querySelectorAll('svg.cal-fly').length === 1
  })()`), '')
  check('装饰不拦截指针（pointer-events: none）',
    await evaluate(`getComputedStyle(document.querySelector('.cal-deco')).pointerEvents === 'none'`), '')
  check('配色方案跟随主题令牌（color-scheme: light）', light.colorScheme === 'light', light.colorScheme)
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
  check('选中移到别处后今天转为热粉字（Y2K 强调色）', afterClick.todayColor === 'rgb(255, 47, 134)' && afterClick.todaySelected === false,
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
  await navigate(URL_BASE + '?skin=y2k')
  const dark = await evaluate(SNAPSHOT)
  await shot('05-dark-auto')
  check('系统深色 → 深色令牌生效（theme=auto）', dark.theme === 'auto' && /23, 20, 29/.test(dark.pageBgImage),
    `theme=${dark.theme} pageBg=${(dark.pageBgImage || '').slice(0, 56)}`)
  check('深色下卡片为中性深紫灰、文字反白',
    /34, 30, 43/.test(dark.cardBgImage) && /243, 238, 250/.test(dark.ink),
    `${(dark.cardBgImage || '').slice(0, 46)} / ${dark.ink}`)
  check('深色下选中态仍是 Y2K 品红→靛紫', /255, 106, 213/.test(dark.selBgImage || ''),
    (dark.selBgImage || '').slice(0, 56))
  check('深色下标题不做铬处理（实心亮字）',
    /243, 238, 250/.test(dark.titleBgImage || '') && !/255, 79, 216/.test(dark.titleBgImage || ''),
    (dark.titleBgImage || '').slice(0, 56))
  check('深色下配色方案转为 dark', dark.colorScheme === 'dark', dark.colorScheme)

  /* ── 7. 强制的深色 + 内嵌形态 ─────────────────────────────────────────────── */
  /* 内嵌时页面底是透明的、由宿主提供；用 CDP 覆盖画布底色模拟宿主，
     否则截图里的透明区会被合成成白底，看不出真实观感。 */
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 26, g: 22, b: 32, a: 1 } })
  await navigate(URL_BASE + '?skin=y2k&embed=1&theme=dark')
  const embed = await evaluate(`(() => {
    const card = document.querySelector('.cal')
    const deco = document.querySelector('.cal-deco')
    return {
      embed: document.documentElement.classList.contains('cal-embed'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      radius: getComputedStyle(card).borderTopLeftRadius,
      maxWidth: getComputedStyle(card).maxWidth,
      decoDisplay: deco ? getComputedStyle(deco).display : null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      title: document.getElementById('calTitle').textContent,
    }
  })()`)
  await shot('06-embed-dark')
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {})
  check('?embed=1 生效：透明底 / 去卡片外观', embed.embed === true && /rgba\(0, 0, 0, 0\)/.test(embed.bodyBg) &&
    parseFloat(embed.radius) === 0 && embed.maxWidth === 'none',
    `bodyBg=${embed.bodyBg} radius=${embed.radius} maxWidth=${embed.maxWidth}`)
  check('?embed=1 装饰收起（面板不是海报）', embed.decoDisplay === 'none', embed.decoDisplay)
  check('?embed=1 color-scheme=normal（否则宿主底透不出来）', embed.colorScheme === 'normal', embed.colorScheme)

  /* ── 8. 外部请求：默认 1 个外链字体；?font=0 回到零请求 ───────────────────── */
  const isExternal = (u) => !u.startsWith(URL_BASE.split('/dsh-calendar')[0])
  await navigate(URL_BASE + '?skin=y2k&theme=light&font=0')
  const offResources = await evaluate(`performance.getEntriesByType('resource').map((r) => r.name)`)
  const offExternal = offResources.filter(isExternal)
  check('?font=0 → 零外部资源请求（离线可用）', offExternal.length === 0,
    `resources=${offResources.length} external=${offExternal.length}`)

  await navigate(URL_BASE + '?skin=y2k&theme=light')
  const onResources = await evaluate(`performance.getEntriesByType('resource').map((r) => r.name)`)
  const onExternal = onResources.filter(isExternal)
  check('默认加载外链圆体 Fredoka/Nunito', onExternal.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
    `external=${onExternal.length}`)
  check('默认的外部域仅 Google Fonts（无其它外链）',
    onExternal.length > 0 && onExternal.every((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
    onExternal.join(',').slice(0, 80))

  /* ── 9. 皮肤 2：Windows 95（?skin=win95）──────────────────────────────────── */
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await navigate(URL_BASE + '?skin=win95&theme=light')
  const w95 = await evaluate(SNAPSHOT)
  await shot('08-win95-light')
  check('?skin=win95 → 皮肤属性落地', w95.skin === 'win95', w95.skin)
  check('win95：直角（窗口不兴圆角）', parseFloat(w95.cardRadius) === 0, w95.cardRadius)
  check('win95：卡片改走立体边，柔和投影必须清干净',
    w95.cardShadow === 'none' && !/blur/.test(w95.cardBackdrop || ''),
    `shadow=${w95.cardShadow} backdrop=${w95.cardBackdrop}`)
  check('win95：标题栏是海军蓝→亮蓝渐变条',
    /linear-gradient/.test(w95.titleBgImage || '') && /0, 0, 128/.test(w95.titleBgImage) &&
    /16, 132, 208/.test(w95.titleBgImage),
    (w95.titleBgImage || '').slice(0, 60))
  check('win95：标题栏白字（Y2K 的铬面裁切已撤销）',
    w95.titleColor === 'rgb(255, 255, 255)' && w95.titleFill === 'rgb(255, 255, 255)',
    `${w95.titleColor} / ${w95.titleFill}`)
  check('win95：标题用像素字 VT323', /\bVT323\b/.test(w95.titleFont), w95.titleFont)
  check('win95：日期格是白底 1px 立体边、直角',
    w95.dayBorder === '1px solid' && parseFloat(w95.dayRadius) === 0,
    `${w95.dayBorder} radius=${w95.dayRadius}`)
  check('win95：选中日是海军蓝方块（不是渐变圆）',
    w95.selBg === 'rgb(0, 0, 128)' && parseFloat(w95.selRadius) === 0,
    `${w95.selBg} radius=${w95.selRadius}`)
  check('win95：青绿桌面 + 网纹抖动（repeating-conic-gradient）',
    w95.pageBg === 'rgb(0, 128, 128)' && /repeating-conic-gradient/.test(w95.pageBgImage || ''),
    `${w95.pageBg} ${(w95.pageBgImage || '').slice(0, 40)}`)
  check('win95：无横向溢出', w95.scrollW <= w95.clientW + 1, `${w95.scrollW} <= ${w95.clientW}`)

  /* 深色 = 「夜间」复古变体（保留，不是砍掉） */
  await navigate(URL_BASE + '?skin=win95&theme=dark')
  const w95d = await evaluate(SNAPSHOT)
  await shot('09-win95-dark')
  check('win95 夜间：深色桌面令牌生效', w95d.pageBg === 'rgb(26, 26, 46)', w95d.pageBg)
  check('win95 夜间：标题栏仍是渐变条（换深蓝）',
    /linear-gradient/.test(w95d.titleBgImage || '') && /0, 0, 64/.test(w95d.titleBgImage),
    (w95d.titleBgImage || '').slice(0, 60))

  /* ── 10. 皮肤 3：赛璐璐（?skin=cel）────────────────────────────────────────── */
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await navigate(URL_BASE + '?skin=cel&theme=light')
  const cel = await evaluate(SNAPSHOT)
  await shot('10-cel-light')
  check('?skin=cel → 皮肤属性落地', cel.skin === 'cel', cel.skin)
  check('cel：全页零渐变（卡片底图与标题底图都是 none）',
    cel.cardBgImage === 'none' && cel.titleBgImage === 'none', `${cel.cardBgImage} / ${cel.titleBgImage}`)
  check('cel：硬位移阴影 4px 4px 0（无模糊、非 rgba）',
    /4px 4px 0px 0px/.test(cel.cardShadow || '') && !/rgba\(/.test(cel.cardShadow || ''),
    cel.cardShadow)
  check('cel：卡片与日期格都是 3px 实心描边',
    parseFloat(cel.cardBorder) === 3 && cel.dayBorder === '3px solid',
    `card=${cel.cardBorder} day=${cel.dayBorder}`)
  check('cel：全直角', parseFloat(cel.cardRadius) === 0 && parseFloat(cel.dayRadius) === 0,
    `${cel.cardRadius} / ${cel.dayRadius}`)
  check('cel：标题黑体加粗大写', cel.titleColor === 'rgb(26, 26, 46)' && cel.titleTransform === 'uppercase',
    `${cel.titleColor} / ${cel.titleTransform}`)
  check('cel：标题真的用上 Baloo 2（只加载不应用=白拉一次字）',
    /Baloo 2/.test(cel.titleFont), cel.titleFont)
  check('cel：选中日是平面红方块 #e63946',
    cel.selBg === 'rgb(230, 57, 70)' && parseFloat(cel.selRadius) === 0,
    `${cel.selBg} radius=${cel.selRadius}`)
  check('cel：平面米白底 #fafaf5（无渐变）',
    cel.pageBg === 'rgb(250, 250, 245)' && cel.pageBgImage === 'none', `${cel.pageBg} / ${cel.pageBgImage}`)
  /* 不用强调色是算过对比度的：#4ea8de 在米白底上只有 2.6:1，不够 12px 正文的 4.5:1 */
  check('cel：星期表头是实心墨而非弱化灰', cel.weekdayColor === 'rgb(26, 26, 46)', cel.weekdayColor)
  check('cel：无横向溢出', cel.scrollW <= cel.clientW + 1, `${cel.scrollW} <= ${cel.clientW}`)

  await navigate(URL_BASE + '?skin=cel&theme=dark')
  const celd = await evaluate(SNAPSHOT)
  await shot('11-cel-dark')
  check('cel 深色：深蓝底 + 反白硬阴影',
    celd.pageBg === 'rgb(20, 20, 40)' && /250, 250, 245/.test(celd.cardShadow || ''),
    `${celd.pageBg} / ${celd.cardShadow}`)

  /* 减少动态效果：本风格的位移 / 挤压 / 斜条纹都是装饰性运动，必须关掉 */
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }],
  })
  await navigate(URL_BASE + '?skin=cel&theme=light')
  const celRM = await evaluate(`(() => {
    const b = document.getElementById('calNext')
    return {
      duration: getComputedStyle(b).transitionDuration,
      stripe: getComputedStyle(b, '::after').display,
    }
  })()`)
  check('cel：prefers-reduced-motion 下关掉装饰性动效与斜条纹',
    celRM.duration === '0s' && celRM.stripe === 'none', JSON.stringify(celRM))
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })

  /* ── 11. 页内切换按钮：点一下换皮肤 · 不重载 · 刷新后仍记得 ─────────────────── */
  await navigate(URL_BASE + '?skin=y2k&theme=light')
  const beforeSwitch = await evaluate(SNAPSHOT)
  check('切换按钮显示的是「下一个」皮肤名，且带无障碍说明',
    beforeSwitch.skinLabel === 'Win95' && /Y2K/.test(beforeSwitch.skinTip || ''),
    `${beforeSwitch.skinLabel} / ${beforeSwitch.skinTip}`)
  /* 打个哨兵：页面若被重载，window 上的标记会随之消失 */
  await evaluate(`window.__calNavMark = 'alive'`)
  await evaluate(`document.getElementById('calSkinBtn').click()`)
  await sleep(200)
  const afterSwitch = await evaluate(SNAPSHOT)
  check('点切换按钮 → 皮肤换成 Win95', afterSwitch.skin === 'win95', afterSwitch.skin)
  check('切换是就地改属性，页面没有被重载', await evaluate(`window.__calNavMark === 'alive'`), '')
  check('切换后视觉真的变了（卡片圆角 → 直角）',
    parseFloat(afterSwitch.cardRadius) === 0 && beforeSwitch.cardRadius !== afterSwitch.cardRadius,
    `${beforeSwitch.cardRadius} → ${afterSwitch.cardRadius}`)
  await evaluate(`document.getElementById('calSkinBtn').click()`)
  await sleep(150)
  check('再点一下 → 轮到赛璐璐', (await evaluate(SNAPSHOT)).skin === 'cel', '')
  await evaluate(`document.getElementById('calSkinBtn').click()`)
  await sleep(150)
  check('三下一循环 → 回到 Y2K', (await evaluate(SNAPSHOT)).skin === 'y2k', '')

  /* 持久化：不带 ?skin= 重进，应当记得上次选的皮肤 */
  await evaluate(`document.getElementById('calSkinBtn').click()`)
  await sleep(150)
  await navigate(URL_BASE + '?theme=light')
  check('不带 ?skin= 重进 → 从 localStorage 记起上次的 Win95',
    (await evaluate(SNAPSHOT)).skin === 'win95', '')
  /* 收尾：清掉 localStorage，免得影响之后的手动打开 */
  await evaluate(`try{localStorage.removeItem('cal-skin')}catch(e){}`)
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
