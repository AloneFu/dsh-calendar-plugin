/**
 * dsh-calendar — client 半边（浏览器端 bundle）
 *
 * 形态：DSH web 客户端插件（`dsh.client` + `exports["./client"]` 的 bundle 约定）。
 * 产物被 `window.__ModuleLoader__.load({ id, factory })` 包裹，factory 只 require
 * 平台自带的 "react"，不引入任何第三方运行时依赖。
 *
 * 注册三样东西：
 *   1. 类型：ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })
 *      —— 一个"页类型"（不认领 dsh-resource 地址），按 kind 打开；guide 条目让它在
 *         右侧栏 tab 条的「+」引导页里出现一个入口胶囊。
 *   2. 正文：keyed slot `sidebar.right.pane.tab`（key = 上面的 id）。
 *   3. 入口按钮：`conversation.session.header.utilities` 里一枚日历图标按钮，
 *      点一下直接 ctx.sidebarRight.openTab('calendar')，省掉找「+」的一步。
 *
 * 正文实现：一个铺满面板的 iframe，指向 host 半边挂载的 /dsh-calendar/preview。
 * 这样单文件日历页是唯一真源，插件不会与它出现两份实现漂移；iframe 内的主题
 * 由宿主探测后经 window.DSHCalendar.setTheme() 推入，配色跟随 DSH 应用而非操作系统。
 */

window.__ModuleLoader__.load({
  id: 'dsh-calendar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 本实现在 tab 系统里的唯一 id，同时也是正文注册所用的 key。 */
    const ID = 'dsh-calendar'
    /** 页类型 kind（一个 kind 最多承载一份 builtin + 一份 extension）。 */
    const KIND = 'calendar'
    /** host 半边挂载的预览路由（单文件日历页）。 */
    const PREVIEW_PATH = '/dsh-calendar/preview'

    const inject = ['slots', 'sidebarRightTabs']

    /** apply 留下的上下文引用，供 header 图标按钮调用 ctx.sidebarRight.openTab。 */
    let serviceCtx = null

    /* ── 主题探测 ────────────────────────────────────────────────────────────
     * DSH 客户端把主题暴露为一组 --dsw-alias-* CSS 变量；取其中一个背景色算亮度，
     * 比猜 data-theme / class 名更稳（宿主换主题实现也不会失效）。 */
    const PROBE_VARS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-3']

    /** 从计算样式里解析出 rgb(a)，失败返回 null。 */
    function parseColor(value) {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(String(value || ''))
      if (!m) return null
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) }
    }

    /** 相对亮度 → 'dark' | 'light'；透明色返回 null 表示"这一项测不到"。 */
    function luminanceTheme(color) {
      if (!color || color.a <= 0.1) return null
      return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) < 128 ? 'dark' : 'light'
    }

    function themeOf() {
      const root = getComputedStyle(document.documentElement)
      for (const name of PROBE_VARS) {
        const theme = luminanceTheme(parseColor(root.getPropertyValue(name)))
        if (theme) return theme
      }
      if (document.body) {
        const theme = luminanceTheme(parseColor(getComputedStyle(document.body).backgroundColor))
        if (theme) return theme
      }
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }

    function previewSrc(sessionId) {
      const params = ['embed=1', 'theme=' + themeOf()]
      if (sessionId) params.push('session=' + encodeURIComponent(sessionId))
      return PREVIEW_PATH + '?' + params.join('&')
    }

    /* ── 面板高度自适应 ────────────────────────────────────────────────────────
     * 教训（实测）：`sidebar.right.pane.tab` 的坐席把我的根元素直接放进停靠格，
     * 不保证父级是"有确定高度的 flex 容器"。此时 iframe 的 `height:100%` 解析成
     * auto → 退回 Chromium 的 iframe 默认高度 150px，面板里只露出大标题与星期表头，
     * 月历网格（y≈147 起）整片被裁掉——用户看到的就是"无日期"。
     * 所以高度不能只靠 CSS 百分比：这里量出来写死像素，并跟着面板尺寸变化重算。
     * 这段被 verify/fit-logic.test.mjs 按标记抽取做回归测试。
     */
    // #region 面板高度自适应
    /** 兜底高度：放得下整月（页面 embed 布局：表头栈 154px + 6 行 × 44px = 418px，留一点余量）。 */
    const MIN_FRAME_HEIGHT = 430
    /** 低于此高度即认为"没拿到确定高度"（150 = iframe 默认值，240 = 明显太小）。 */
    const USABLE_FRAME_HEIGHT = 240

    /**
     * 量出内嵌 iframe 应有的高度（px）；返回 0 表示"CSS 已经给够了，别插手"。
     *
     * 从宿主容器向**上**找第一个有确定高度的祖先：不读宿主容器自身的高度，
     * 因为它的高度正是 iframe 撑出来的，读它会自反馈。
     * @param host - 面板根元素（.dsh-calendar-host）
     * @param frame - 内嵌 iframe
     */
    function frameHeightFor(host, frame) {
      let node = host && host.parentElement
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        const h = node.clientHeight
        if (h >= USABLE_FRAME_HEIGHT) return h
      }
      const cssHeight = frame && frame.clientHeight ? frame.clientHeight : 0
      if (cssHeight >= USABLE_FRAME_HEIGHT) return 0
      return MIN_FRAME_HEIGHT
    }

    /**
     * 应用高度：height > 0 写内联像素高度，0 清掉内联值交回 CSS。
     * @returns 实际写入的 CSS 值（便于测试断言）
     */
    function applyFrameHeight(frame, height) {
      const next = height > 0 ? height + 'px' : ''
      if (frame.style.height !== next) frame.style.height = next
      return next
    }
    // #endregion

    /* ── 安装向导：首次使用时让用户给出 Obsidian 日记文件夹 ───────────────────
     * 这一段的纯函数被 scripts/setup.test.mjs 抽取做回归。 */
    // #region 安装向导
    /** 保存失败时给用户看的一句话。 */
    function setupErrorText(result) {
      if (!result) return '保存失败'
      if (result.error === 'empty-path') return '请先填写或选择日记文件夹'
      if (result.error === 'not-a-directory') return '这个路径不存在，或者不是一个文件夹'
      if (result.error === 'too-broad') return '不能选整块盘、系统目录或用户主目录本身，请选具体的日记文件夹'
      if (result.error === 'missing-write-header') return '保存被拒绝（缺少写标头）'
      if (result.error === 'bad-origin') return '保存被拒绝（来源不是本机）'
      return '保存失败：' + String(result.error || 'unknown')
    }

    /** 检测到的候选：给按钮上的一行小字。 */
    function candidateSummary(candidate) {
      if (!candidate) return ''
      const bits = []
      bits.push(candidate.hasDailyConfig ? 'Daily Notes：' + (candidate.dailyFolder || 'vault 根') : '未配置 Daily Notes（用 vault 根）')
      bits.push(candidate.dateFormat || 'YYYY-MM-DD')
      if (candidate.dayPlanner && candidate.dayPlanner.installed) bits.push('有 Day Planner')
      if (candidate.calendar && candidate.calendar.installed) bits.push('有 Calendar')
      return bits.join(' · ')
    }
    // #endregion

    /** 首次使用向导：自动寻找本机 vault，或手填路径，保存后即可用。 */
    function CalendarSetup(props) {
      const [root, setRoot] = React.useState('')
      const [detected, setDetected] = React.useState([])
      const [probing, setProbing] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const rootRef = React.useRef('')
      rootRef.current = root

      const probe = React.useCallback(() => {
        setProbing(true)
        setError('')
        fetch('/dsh-calendar/setup?detect=1', { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            setProbing(false)
            if (!data) { setError('自动寻找失败：host 没有响应'); return }
            const list = Array.isArray(data.detected) ? data.detected : []
            setDetected(list)
            if (rootRef.current === '' && list.length > 0) setRoot(list[0].root)
            if (list.length === 0) setError('没在本机的常见位置找到 Obsidian vault（缺 .obsidian 目录），请手动填写路径')
          })
          .catch(() => { setProbing(false); setError('自动寻找失败：连不上 host') })
      }, [])

      React.useEffect(() => { probe() }, [probe])

      const save = React.useCallback(() => {
        const value = rootRef.current.trim()
        if (value === '') { setError('请先填写或选择日记文件夹'); return }
        setSaving(true)
        setError('')
        fetch('/dsh-calendar/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-calendar': 'write' },
          body: JSON.stringify({ root: value }),
        })
          .then((response) => response.json().catch(() => null))
          .then((data) => {
            setSaving(false)
            if (!data || data.ok !== true) { setError(setupErrorText(data)); return }
            if (props.onReady) props.onReady()
          })
          .catch(() => { setSaving(false); setError('保存失败：连不上 host') })
      }, [props])

      const items = detected.map((candidate) => React.createElement('li', { key: candidate.root },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-calendar-setup-item' + (root === candidate.root ? ' is-selected' : ''),
          onClick: () => setRoot(candidate.root),
        },
          React.createElement('span', { className: 'dsh-calendar-setup-item-name' }, candidate.name || candidate.root),
          React.createElement('span', { className: 'dsh-calendar-setup-item-path' }, candidate.root),
          React.createElement('span', { className: 'dsh-calendar-setup-item-meta' }, candidateSummary(candidate)))))

      return React.createElement('div', { className: 'dsh-calendar-setup', 'data-dsh-calendar': ID + '-setup' },
        React.createElement('h3', { className: 'dsh-calendar-setup-title' }, '连接 Obsidian'),
        React.createElement('p', { className: 'dsh-calendar-setup-note' },
          '选一个日记文件夹：插件会把当天的日记、待办与时间轴（Day Planner 风格）显示在这里，勾选完成会写回原文件。'),
        React.createElement('ol', { className: 'dsh-calendar-setup-steps' },
          React.createElement('li', null, '在 Obsidian 里启用或安装 ', React.createElement('b', null, 'Day Planner'),
            '（时间轴）与 ', React.createElement('b', null, 'Calendar'), '（日记字数点）——没装也能用，只是少一点功能'),
          React.createElement('li', null, '把日记文件夹路径填到下面（Obsidian 的 Daily Notes 文件夹）')),
        React.createElement('div', { className: 'dsh-calendar-setup-row' },
          React.createElement('input', {
            className: 'dsh-calendar-setup-input',
            type: 'text',
            value: root,
            spellCheck: false,
            placeholder: '例如 D:\\Obsidian\\MyVault\\日记',
            'aria-label': 'Obsidian 日记文件夹路径',
            onChange: (event) => setRoot(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') save() },
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-calendar-setup-btn',
            onClick: probe,
            disabled: probing,
          }, probing ? '寻找中…' : '自动寻找')),
        items.length > 0 ? React.createElement('ul', { className: 'dsh-calendar-setup-list' }, items) : null,
        React.createElement('div', { className: 'dsh-calendar-setup-actions' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-calendar-setup-primary',
            onClick: save,
            disabled: saving,
          }, saving ? '保存中…' : '保存并开始使用')),
        error ? React.createElement('p', { className: 'dsh-calendar-setup-error' }, error) : null,
        React.createElement('p', { className: 'dsh-calendar-setup-hint' },
          '也可以让 AI 帮你配：把本插件目录下的 README 给 AI 看，它会用 node scripts/setup.mjs --detect 自动找路径。'))
    }

    /* ── 面板正文：没配好先给向导，配好了挂 iframe ─────────────────────────── */
    function CalendarPanel(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [phase, setPhase] = React.useState('checking')

      const check = React.useCallback(() => {
        fetch('/dsh-calendar/setup', { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!data) { setPhase('ready'); return }        // host 太老没有这个路由 → 按已配置处理
            setPhase(data.configured === false ? 'setup' : 'ready')
          })
          .catch(() => setPhase('ready'))
      }, [])

      React.useEffect(() => { check() }, [check])

      if (phase === 'checking') {
        return React.createElement('div', { className: 'dsh-calendar-setup' },
          React.createElement('p', { className: 'dsh-calendar-setup-note' }, '正在读取配置…'))
      }
      if (phase === 'setup') {
        return React.createElement(CalendarSetup, { sessionId: sessionId, onReady: () => setPhase('ready') })
      }
      return React.createElement(CalendarFrame, { sessionId: sessionId })
    }

    /** 配置已就绪时的正文：宿主容器 + 内嵌 iframe（单文件日历页）。 */
    function CalendarFrame(props) {
      const hostRef = React.useRef(null)
      /** 会话 id（由坐席经 inject(sessionId) 传入）：页面据此向 host 要当前会话工作区的任务。 */
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''

      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined

        const frame = document.createElement('iframe')
        frame.className = 'dsh-calendar-frame'
        frame.title = '日历'
        frame.src = previewSrc(sessionId)
        frame.setAttribute('data-dsh-calendar', ID)
        host.appendChild(frame)

        // 高度自适应：先量一次，再补几次（停靠格开合有过渡，挂载那刻可能还没有高度），
        // 之后跟着父容器尺寸变化与窗口缩放重算。
        const fit = () => applyFrameHeight(frame, frameHeightFor(host, frame))
        fit()
        const timers = [60, 220, 600].map((ms) => setTimeout(fit, ms))
        const watch = host.parentElement
        let resizes = null
        if (watch && typeof ResizeObserver === 'function') {
          resizes = new ResizeObserver(fit)
          resizes.observe(watch)
        }
        window.addEventListener('resize', fit)

        // 主题跟随：宿主主题变化时就地推给内嵌页（不重载，保住已选日期与月份）
        let current = themeOf()
        const sync = () => {
          const next = themeOf()
          if (next === current) return
          current = next
          try {
            const api = frame.contentWindow && frame.contentWindow.DSHCalendar
            if (api && typeof api.setTheme === 'function') {
              api.setTheme(next)
              return
            }
          } catch (error) {
            /* 跨域或页面尚未加载完 → 退回重设 src */
          }
          frame.src = previewSrc(sessionId)
        }

        const observer = new MutationObserver(sync)
        const attrs = ['class', 'style', 'data-theme', 'data-color-scheme']
        observer.observe(document.documentElement, { attributes: true, attributeFilter: attrs })
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: attrs })

        const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        if (media && media.addEventListener) media.addEventListener('change', sync)

        return () => {
          observer.disconnect()
          if (media && media.removeEventListener) media.removeEventListener('change', sync)
          for (const timer of timers) clearTimeout(timer)
          if (resizes) resizes.disconnect()
          window.removeEventListener('resize', fit)
          if (frame.parentNode === host) host.removeChild(frame)
        }
      }, [])

      return React.createElement('div', { className: 'dsh-calendar-host', ref: hostRef })
    }

    /* ── 会话 header 里的入口按钮 ──────────────────────────────────────────── */
    function CalendarGlyph() {
      return React.createElement('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        'aria-hidden': 'true',
      },
        React.createElement('rect', {
          x: 2, y: 3.2, width: 12, height: 10.8, rx: 2.4,
          stroke: 'currentColor', strokeWidth: 1.4,
        }),
        React.createElement('path', {
          d: 'M5.2 1.8v2.6M10.8 1.8v2.6',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M2 6.6h12',
          stroke: 'currentColor', strokeWidth: 1.4,
        }),
      )
    }

    /** 打开（或聚焦）右侧栏的日历 tab；没有已挂载的会话停靠面时静默失败。 */
    function openCalendar() {
      try {
        const right = serviceCtx && typeof serviceCtx.get === 'function' ? serviceCtx.get('sidebarRight') : null
        if (right && typeof right.openTab === 'function') {
          right.openTab(KIND, {})
          return true
        }
      } catch (error) {
        /* 命令需要一个已挂载的会话停靠面，没有时什么都不做 */
      }
      return false
    }

    /* ── 自动打开：每个会话第一次见到时就展开日历 tab（可被 host 配置关掉） ────
     * 记住"已经为哪些会话开过"，所以你在某个对话里手动关掉之后**不会**被弹回来。
     * 这段纯逻辑被 scripts/auto-open.test.mjs 抽取做回归。 */
    // #region 自动打开
    function createAutoOpener() {
      const opened = Object.create(null)
      const keyOf = (sessionId) =>
        String(sessionId === undefined || sessionId === null || sessionId === '' ? 'default' : sessionId)
      return {
        /** 第一次见到这个会话 → true（并记账）；之后一律 false。 */
        shouldOpen(sessionId) {
          const key = keyOf(sessionId)
          if (opened[key]) return false
          opened[key] = true
          return true
        },
        /** 打开失败时撤销记账，允许下次再试（例如侧栏服务还没就绪）。 */
        forget(sessionId) {
          delete opened[keyOf(sessionId)]
        },
        count() {
          return Object.keys(opened).length
        },
      }
    }
    // #endregion

    const autoOpener = createAutoOpener()

    /**
     * 自动展开日历 tab：先问一次 host 的开关（默认开），再尝试打开；
     * 侧栏服务尚未就绪时退避重试，彻底失败就撤销记账，留待下次机会。
     * @returns 清理函数（组件卸载时停止重试）
     */
    function maybeAutoOpen(sessionId) {
      if (!autoOpener.shouldOpen(sessionId)) return undefined
      let cancelled = false
      const attempt = (tries) => {
        if (cancelled) return
        if (openCalendar()) return
        if (tries > 0) setTimeout(() => attempt(tries - 1), 400)
        else autoOpener.forget(sessionId)
      }
      const run = () => attempt(6)
      try {
        fetch('/dsh-calendar/status', { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => { if (!data || data.autoOpen !== false) run() })
          .catch(run)
      } catch (error) {
        run()
      }
      return () => { cancelled = true }
    }

    /** 会话 header 里的日历按钮；顺带承担"进入对话就展开日历"的副作用。 */
    function CalendarHeaderButton(props) {
      const sessionId = props && props.sessionId
      React.useEffect(() => maybeAutoOpen(sessionId), [sessionId])
      return React.createElement('button', {
        type: 'button',
        className: 'dsh-calendar-header-btn',
        title: '日历',
        'aria-label': '日历',
        'data-dsh-calendar': ID + '-open',
        onClick: openCalendar,
      }, React.createElement(CalendarGlyph))
    }

    /* ── 样式：只负责内嵌容器与入口按钮，日历外观住在单文件页里 ─────────────── */
    const CSS = [
      '.dsh-calendar-host{display:flex;flex:1 1 auto;flex-direction:column;',
      'width:100%;height:100%;min-width:0;min-height:0}',
      '.dsh-calendar-frame{display:block;flex:1 1 auto;width:100%;height:100%;min-height:0;',
      'border:0;background:transparent}',
      '.dsh-calendar-header-btn{display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#8a8a8e);cursor:pointer;',
      'transition:background-color .12s ease-out,color .12s ease-out}',
      '.dsh-calendar-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.14));',
      'color:var(--dsw-alias-label-primary,#000)}',
      /* 安装向导 */
      '.dsh-calendar-setup{display:flex;flex-direction:column;gap:10px;padding:16px 14px;',
      'font-family:inherit;color:var(--dsw-alias-label-primary,#000);overflow-y:auto}',
      '.dsh-calendar-setup-title{margin:0;font-size:15px;font-weight:600}',
      '.dsh-calendar-setup-note{margin:0;font-size:12px;line-height:1.5;',
      'color:var(--dsw-alias-label-secondary,#6b6b70)}',
      '.dsh-calendar-setup-steps{margin:0;padding-left:18px;font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-label-secondary,#6b6b70)}',
      '.dsh-calendar-setup-row{display:flex;gap:6px;align-items:center}',
      '.dsh-calendar-setup-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;padding:7px 9px;',
      'border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12));',
      'color:inherit;outline:none}',
      '.dsh-calendar-setup-input:focus{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#0a84ff)}',
      '.dsh-calendar-setup-btn,.dsh-calendar-setup-primary{font:inherit;font-size:12px;cursor:pointer;',
      'border:0;border-radius:8px;padding:7px 11px;white-space:nowrap}',
      '.dsh-calendar-setup-btn{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.14));',
      'color:inherit}',
      '.dsh-calendar-setup-primary{background:var(--dsw-alias-brand-primary,#0a84ff);color:#fff;font-weight:600}',
      '.dsh-calendar-setup-btn:disabled,.dsh-calendar-setup-primary:disabled{opacity:.55;cursor:default}',
      '.dsh-calendar-setup-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;',
      'max-height:190px;overflow-y:auto}',
      '.dsh-calendar-setup-item{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;',
      'font:inherit;cursor:pointer;border:0;border-radius:8px;padding:7px 9px;background:transparent;color:inherit}',
      '.dsh-calendar-setup-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12))}',
      '.dsh-calendar-setup-item.is-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.18));',
      'box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#0a84ff)}',
      '.dsh-calendar-setup-item-name{font-size:12px;font-weight:600}',
      '.dsh-calendar-setup-item-path,.dsh-calendar-setup-item-meta{font-size:11px;',
      'color:var(--dsw-alias-label-secondary,#6b6b70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-calendar-setup-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-calendar-setup-error{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-status-danger,#ff3b30)}',
      '.dsh-calendar-setup-hint{margin:0;font-size:11px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#9a9aa0)}',
    ].join('')

    function ensureStyle() {
      const existing = document.getElementById('dsh-calendar-style')
      if (existing) return () => {}
      const style = document.createElement('style')
      style.id = 'dsh-calendar-style'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { if (style.parentNode) style.parentNode.removeChild(style) }
    }

    /* ── 装配 ──────────────────────────────────────────────────────────────── */
    function apply(ctx) {
      serviceCtx = ctx

      ctx.effect(ensureStyle, 'dsh-calendar: panel styles')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        // 坐席会把当前会话 id 交给我们 → 页面据此向 host 要该会话工作区的任务
        inject: (sessionId) => ({ sessionId }),
      }, CalendarPanel)), 'dsh-calendar: tab body')

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: ID + '/open',
        // 坐席把当前会话 id 交给我们 → 自动打开可以"每个会话各记账一次"
        inject: (sessionId) => ({ sessionId }),
      }, CalendarHeaderButton)), 'dsh-calendar: header button')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => '日历',
        guide: [{
          order: 45,
          title: () => '日历',
          description: () => '简约月历 · 今日高亮 · 周一起始',
        }],
      }), 'dsh-calendar: tab type')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
