/* 重拍商城截图。

   ⚠️ 隐私红线：截图会公开在插件市场详情页上，**必须**用一套虚构的演示日记渲染，
   绝不能指向真实 vault —— 否则会把真实的日程、待办、日记正文连同用户的目录结构一起发出去。
   所以本脚本要求第 4 个参数显式给出演示数据根，并把它作为 ?root= 传给页面；
   缺参数直接退出，不提供"默认用配置里的 vault"这种会出事的行为。

   另：宽度用 Emulation.setDeviceMetricsOverride 设定 —— 命令行 --window-size 会被
   Windows 夹到最小 500px，导致 460px 的排版被裁掉右边缘。 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PAGE = process.argv[2]
const OUT = process.argv[3]
/** 演示数据根（必须是虚构内容）。页面通过 ?root= 读取它，而不是读配置里的真实数据源。 */
const DEMO_ROOT = process.argv[4]
if (!PAGE || !OUT || !DEMO_ROOT) {
  console.error('用法: node scripts/store-shots.mjs <页面URL> <输出目录> <演示数据根>')
  console.error('  例: node scripts/store-shots.mjs "http://127.0.0.1:3080/dsh-calendar/preview" assets "D:\\demo\\notes"')
  console.error('  ⚠️ 第三个参数必须是虚构演示数据，绝不能是真实 vault（截图会公开）')
  process.exit(1)
}
const rootQuery = '&root=' + encodeURIComponent(DEMO_ROOT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 9700 + Math.floor(Math.random() * 200)

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.waiting = new Map(); this.listeners = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== undefined) {
        const s = this.waiting.get(m.id); if (!s) return
        this.waiting.delete(m.id)
        m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result)
        return
      }
      for (const fn of this.listeners.get(m.method) || []) fn(m.params)
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => {
      this.waiting.set(id, { resolve: res, reject: rej })
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error('timeout ' + method)) }, 30000)
    })
  }
  once(m) {
    return new Promise((res) => {
      const l = this.listeners.get(m) || []
      const fn = (p) => { this.listeners.set(m, (this.listeners.get(m) || []).filter((f) => f !== fn)); res(p) }
      l.push(fn); this.listeners.set(m, l)
    })
  }
  close() { try { this.ws.close() } catch {} }
}

const profile = join(tmpdir(), `dsh-shots-${Date.now()}`)
mkdirSync(profile, { recursive: true })
if (!existsSync(CHROME)) { console.error('no chrome'); process.exit(1) }
mkdirSync(OUT, { recursive: true })

const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=920,1760', 'about:blank',
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const p = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(250)
  }
  throw new Error('CDP never came up')
}

const cdp = await Cdp.connect((await target()).webSocketDebuggerUrl)
try {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 880, deviceScaleFactor: 2, mobile: false })

  const evaluate = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value
  const nav = async (url) => {
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    await sleep(1200)  // 等外链字体落位
  }

  const cap = async (name, cssH) => {
    /* 视口高度必须等于目标高度：页底渐变铺的是 100vh，超出视口的部分会露出空白画布 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 460, height: cssH, deviceScaleFactor: 2, mobile: false })
    await sleep(350)
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const f = join(OUT, name)
    writeFileSync(f, Buffer.from(r.data, 'base64'))
    console.log('wrote', f, '→ 920x' + cssH * 2)
  }

  /* 1..4 是默认皮肤 Y2K —— 文件名保持不变，商城列表里的既有引用不会断。
     5..8 是新增的两套皮肤（Win95 / 赛璐璐）× 浅深。
     每条 URL 都显式带 ?skin= 与 &root=<演示根>，免得被上一个 profile 里残留的
     localStorage 串味，也避免任何一张图落到真实数据源上。 */
  await nav(PAGE + '?skin=y2k&theme=light' + rootQuery); await cap('screenshot-1-light.png', 880)
  await cap('screenshot-2-light-full.png', 1170)
  await nav(PAGE + '?skin=y2k&theme=dark' + rootQuery);  await cap('screenshot-3-dark-full.png', 1170)
  await cap('screenshot-4-dark.png', 880)

  await nav(PAGE + '?skin=win95&theme=light' + rootQuery); await cap('screenshot-5-win95-light.png', 880)
  await nav(PAGE + '?skin=win95&theme=dark' + rootQuery);  await cap('screenshot-6-win95-dark.png', 880)
  await nav(PAGE + '?skin=cel&theme=light' + rootQuery);   await cap('screenshot-7-cel-light.png', 880)
  await nav(PAGE + '?skin=cel&theme=dark' + rootQuery);    await cap('screenshot-8-cel-dark.png', 880)
  console.log('演示数据根:', DEMO_ROOT)
} finally {
  cdp.close()
  try { child.kill() } catch {}
  await sleep(200)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
