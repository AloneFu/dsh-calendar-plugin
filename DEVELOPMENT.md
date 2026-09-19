# dsh-calendar · 开发与验收记录（DEVELOPMENT）

> 这是**开发/验证日志**：实现细节、逐项实测证据、回归脚本说明、缺陷复盘与排错表。
> 面向用户的安装与使用说明在 **[README.md](README.md)**。
> 当前版本：**1.0.0**（正式发布包；本文件随包一起分发，方便复核与二次开发）。

---

## 原始需求与实现概览

一个 iOS 视觉语言的极简月历，以 **DSH web 插件包** 的形式挂在右侧栏（`sidebar.right.pane.tab`）里。
零外部依赖、零外部 API、不加载任何字体/图片/脚本资源，日期计算全部走原生 `Date`。

```
dsh-calendar/
├─ package.json          # 插件清单：dsh.client{platform:'web'} + exports["./client"] + dsh.bundle.patch
├─ cordis.patch.yml      # 官方 CLI 通道用的挂载行（dsh.bundle.patch）
├─ lib/
│  ├─ index.js           # host 半边：/preview 页面 + /tasks 任务 JSON（Obsidian Tasks 只读扫描）+ /status 自检
│  └─ client.js          # client 半边：右侧栏 tab 类型 + 面板正文（iframe 内嵌预览页）+ header 入口按钮
├─ scripts/
│  ├─ verify-ui.mjs          # 页面无头验收（CDP 驱动本机 Chrome/Edge，零 npm 依赖，27 项断言 + 截图）
│  ├─ fit-logic.test.mjs     # 面板高度自适应回归（从 bundle 抽真代码，13 项断言，不需要浏览器）
│  ├─ tasks-parse.test.mjs   # Obsidian Tasks 行解析回归（从 lib/index.js 抽真代码，43 项断言）
│  ├─ tasks-render.test.mjs  # 展示 + 时间轴 + 写回交互回归（从 calendar.html 抽真代码，123 项断言）
│  ├─ auto-open.test.mjs     # 自动打开日历 tab 的记账语义回归（16 项断言）
│  └─ slim-page.mjs          # 页面瘦身（零信息损失），保证 < 64KB 以过交付 gate 的 UTF-8 头切片校验
├─ standalone/
│  └─ calendar.html      # ★ 唯一真源：单文件零依赖日历页（可直接双击打开）
└─ README.md
```

**设计要点：单文件页是唯一真源。** 面板正文是一个指向 `/dsh-calendar/preview` 的 `iframe`，
所以插件里没有第二份日历实现，二者不会漂移。面板会探测 DSH 应用主题（读 `--dsw-alias-bg-base` 等
变量的亮度）并推给内嵌页，因此配色跟随 DSH 外观而不是操作系统。

**面板高度不能只靠 CSS 百分比**：`sidebar.right.pane.tab` 坐席把插件根元素直接放进停靠格，
不保证父级是"有确定高度的 flex 容器"；那种情况下 iframe 的 `height:100%` 会解析成 auto，
退回 Chromium iframe 默认高度 150px，面板里就只露大标题与星期表头（实测缺陷「无日期」）。
所以正文还会用 `ResizeObserver` + 挂载后补量把高度写成像素（就近取第一个有确定高度的祖先，
取不到就兜底 430px）。回归测试见 `scripts/fit-logic.test.mjs`。

---

## 1. 功能与视觉（对照需求）

| 需求 | 实现 |
|---|---|
| 大标题日期 | 30px / 700 字重的大标题（`2026年9月`），其下为选中日说明（含星期） |
| 七列网格 | CSS Grid `repeat(7, 1fr)`，6 行固定 42 格，日期数字在 36px 圆形内居中 |
| 今日高亮 | 默认选中今天（iOS 蓝 `#007AFF` 圆形填充）；选别处后今天转为 iOS 红字 `#FF3B30` |
| 圆角卡片 | 卡片 22px 圆角，靠留白与底色分层 |
| 浅/深色 | `prefers-color-scheme` + CSS 变量；`?theme=light\|dark` 可强制（面板用它跟随宿主） |
| 字体 | `-apple-system, BlinkMacSystemFont, "SF Pro Display/Text", system-ui, "PingFang SC", …` |
| 选中态 | iOS 蓝圆形填充 + 白字 |
| 非当月日期 | `opacity: .28`（深色 `.32`）弱化 |
| 无装饰 | 全局 **零 border、零 box-shadow**（图标为内联 SVG） |
| 左右切月 | 箭头按钮 + 指针滑动手势（横向阈值 48px）+ 键盘 `←/→` |
| 点击选中 | 点击任意一天即高亮该日期，并同步标题下的说明与「今天」按钮显隐 |
| 周起始日 | 周一（`(getDay()+6)%7`） |
| 零依赖 | 无 import / 无 CDN / 无网络请求；host 半边仅用 `node:fs/promises` |
| 任务标记 | 每格下方最多 3 枚任务点：逾期红 · 高优橙 · 待办蓝 · 已完成灰（见第 2 节） |
| 当日任务列表 | 选中日下方列出当天任务：状态字形 + 正文（`#tag` 高亮）+ 优先级/重复/落点/逾期标注 |

补充：跨零点后标签页重新可见时会刷新"今天"；`prefers-reduced-motion` 下关闭切月动效。

---

## 2. 任务视图与 Obsidian 同步

日历扫描笔记库里的 Markdown，把 [Obsidian Tasks](https://publish.obsidian.md/tasks/) 风格的任务行
放到对应日期上：月历格内显示密度点，选中某天后在下方给出**当天时间轴（Day Planner 风格）**、未安排任务与**当天日记**。

```md
- [ ] 提交日历插件交付 📅 2026-09-16 ⏫ #dsh
- [x] 冻结侧栏面板契约 ✅ 2026-09-15
- [ ] 18:00 - 18:50 吃饭          ← Day Planner 时间块
- [ ] 12:30 午休                  ← 只写开始时间（按默认时长补全）
- [-] 迁移旧日历数据
- [ ] 每周复盘 🔁 every week 📅 2026-09-21
- [ ] 整理桌面 ⏳ 2026-09-19
```

| 语法 | 含义 | 在日历上的作用 |
|---|---|---|
| `HH:mm - HH:mm` / `HH:mm` | **Day Planner 时间块** | 落到当天**时间轴**对应小时；只写开始时按 `defaultDurationMinutes` 补 |
| `- [ ]` / `- [x]` / `[-]` | 待办 / 完成 / 取消 | 状态字形 ○ ✓ ✕；完成与取消划线弱化 |
| `📅 YYYY-MM-DD` | due 截止 | **首选**落点（这天出现在月历上） |
| `⏳` / `🛫` | scheduled 计划 / start 开始 | 没有 due 时依次兜底，列表里标 `⏳` / `🛫` |
| `⏫ 🔼 🔽 ⏬ 🔺` | 优先级（high/medium/low/lowest/highest） | 高优（⏫/🔺）的点是橙色；列表里排前面 |
| `➕` / `✅` / `❌` | 创建 / 完成 / 取消日期 | ✅ 参与写回；其余保留在数据里 |
| `🔁 规则` | 重复 | 列表里标 🔁（本版**不做**自动生成下一次） |
| `#tag` | 标签 | 列表里以强调色高亮 |
| 没有日期 | — | 不上月历；日记里的算当天，其它只在底部计入"未排期" |

### 与你已装的 Obsidian 插件对齐

两个插件的配置都被读取并对应上了（值取自它们自己的 `data.json`）：

| 插件 | 对齐项 | 在 DSH 里体现 |
|---|---|---|
| **obsidian-day-planner** v0.35.1 | `timelineDateFormat: YYYY-MM-DD` | 日记文件名识别（同名格式） |
| | `firstDayOfWeek: monday` | 月历周一起始 |
| | `startHour: 6` · `defaultDurationMinutes: 30` · `minimalDurationMinutes: 10` · `snapStepMinutes: 10` | 时间轴与时间编辑的取值 |
| | `showNow: true` | 今天的时间轴上有**「现在」红线**（按分钟定位） |
| | `progressIndicator: mini-timeline` | 任务上方的**完成进度条**（`3/8 完成 · 2 个已排时间`） |
| | `plannerHeading: Day planner`（level 1） | 在 DSH 新建带时间的待办时写进 `# Day planner` 小节 |
| **calendar** v1.5.10（Liam Cain） | `wordsPerDot: 250` | 日期格里的**灰色字数点**（每 250 字一枚，窄面板上限 2 枚） |
| | 悬停看当天情况 | 日期格提示：`9月19日 星期六 · 已写 51 词 · 3/8 个任务完成，2 个已排时间` |

两种点排在同一行：**灰色 = 日记字数点**（Calendar），**彩色 = 任务点**（逾期红 · 高优橙 · 待办蓝 · 完成灰）。

### 当天时间轴（紧凑式）

只展开"真正有安排的小时"（每个时间块前后各留一小时上下文，再加上今天"现在"的前后一小时），
中间连续的空白小时折叠成一条 `⋯ 3 小时无安排` —— 窄侧栏里一屏看完，不用从 06:00 滚到 23:00。

- 有时间的任务进时间轴，**没时间的进下方「未安排」分组**
- 今天画**「现在」红线**；页面每次刷新/轮询都会更新位置
- 时间胶囊（`18:00 - 18:50`）可点：弹出两个原生时间输入框，**✓ 保存 · 清除（变回未安排）· ✕ 取消**；
  回车=保存、Esc=取消；只填了结束时间会自动当成开始时间
- 时间不合法（结束早于开始等）→ **400**，页面给人话提示，**文件不动**

### 新建待办

任务区底部 `新建待办…` + 时间输入 + `添加`：

- 带时间 → 写进当天日记的 `# Day planner` 小节（没有就自动建）
- 不带时间 → 追加到当天日记末尾
- 当天日记不存在 → 先按 `titleTemplate` 建出来（首行 `# 2026-09-25 星期五`）
- 只追加，**绝不覆盖**已有一行

```md
# 2026-09-25 星期五

# Day planner

- [ ] 09:00 - 11:00 写代码
- [ ] 12:30 午休

- [ ] 不带时间的杂事
```

### 数据源：`$DSH_HOME/dsh-calendar/config.json`

本机的配置（已按你的 Obsidian 目录写好）：

```json
{
  "roots": [
    "C:\\Users\\b2267\\Documents\\Obsidian Vault\\日历&备忘录",
    "D:\\what's_today\\notes"
  ],
  "allowAnyRoot": false,
  "write": { "enabled": true, "appendDoneDate": true },
  "create": { "enabled": true, "titleTemplate": "# {date} {weekday}" },
  "dayPlanner": {
    "heading": "Day planner", "headingLevel": 1, "startHour": 6,
    "defaultDurationMinutes": 30, "minimalDurationMinutes": 10,
    "snapStepMinutes": 10, "showNow": true, "showNext": true
  },
  "calendar": { "wordsPerDot": 250, "maxNoteDots": 2 }
}
```

- `roots[0]` 是**主数据源**（面板默认就看它）；`roots` 里的其它路径可用 `?root=<路径>` 切换
- 该文件**优先于** loader 行里的 `config`，改完下一次请求即生效（无需重载插件）
- `allowAnyRoot: false` = 只认 `roots` 与 DSH 已注册工作区，挡掉 `?root=C:\任意路径`

### 日记（Obsidian daily notes）

任何**文件名里带日期**的 md 都会被认作那天的日记（`2026-09-16` / `2026-09-16 星期三` / `2026.9.6` /
`2026年9月16日` / `20260916`）。选中那天时，面板在任务列表下方显示一个可折叠的「📓 文件名 · 体积 · N 个任务」块，
展开即看正文摘要（自动去掉 frontmatter、围栏代码块与任务行）。

本来没有那一天的文件时，出现 **「新建这一天的日记」**：按 `titleTemplate` 写入 `<roots[0]>/YYYY-MM-DD.md`
（默认首行 `# 2026-09-16 星期三`）。**已存在则 409 拒绝，绝不覆盖。**

Obsidian 侧已配套写好 `.obsidian/daily-notes.json`（原文件若存在会先备份成 `.bak`）：

```json
{ "folder": "日历&备忘录", "format": "YYYY-MM-DD", "template": "", "autorun": false }
```

于是在 Obsidian 里按「Open today's daily note」就会建在同一个文件夹、用同一种命名 —— 两边自然对齐。

### 写回：点圆圈改完成状态

任务行左侧的 `○ / ✓ / ✕` 是按钮，点一下就写回你的笔记：

| 动作 | 文件里发生什么 |
|---|---|
| 点 `○`（标完成） | `- [ ] 正文 …` → `- [x] 正文 … ✅ 2026-09-16`（已有 `✅` 则只更新日期） |
| 点 `✓`（取消完成） | `- [x] 正文 … ✅ <日期>` → `- [ ] 正文 …`（移除 `✅` 日期） |
| 关掉 `appendDoneDate` | 只翻 `[ ]`↔`[x]`，行内其它字符一字不动 |
| **点正文**（改内容） | 就地变输入框：回车 / 失焦写回，`Esc` 取消。**只替换描述**，`📅⏳🛫`、优先级、`#tag`、勾选状态、缩进全部原样保留；描述里的换行与连续空格压成单个空格 |
| **点时间胶囊**（改时间） | 弹出两个原生时间输入框：`✓` 保存 / `清除`（移除时间，回到未安排）/ `✕` 取消。**只动行首时间头**，描述与元数据一字不动 |
| **底部输入框**（新建） | 带时间 → 写进当天日记的 `# Day planner` 小节；不带时间 → 追加到日记末尾；日记不存在先建出来（只追加，绝不覆盖） |

行内其它内容（缩进、`-`/`*`/`+`、正文、`📅`/`⏳`/`⏫`/`#tag`）**原样保留**；编码（BOM）与换行风格（CRLF/LF）也保留。

**写回安全**（这是唯一会动你文件的路径，你已明确授权）：

- 只允许改 `roots` 之内的 `.md`，且按 `realpath` 校验（实测挡住 `../dsh-calendar/README.md` → `outside-root`）
- **乐观并发**：请求带上"客户端看到的那一行原文"，与磁盘不符就返回 409 `stale` 并**不写**（防止覆盖你在 Obsidian 里的并发编辑）
- **原子写**：同目录临时文件 + `rename` 覆盖；写完**回读校验**，不一致就报 `verify-failed`
- 同一文件的写请求串行化（互斥），避免并发读改写互相覆盖
- 每次写都追加审计到 `$DSH_HOME/dsh-calendar/writes.jsonl`（不进 vault），格式：
  `{"at":"…","action":"complete","file":"…","line":8,"before":"- [ ] …","after":"- [x] … ✅ 2026-09-16"}`
- 请求必须带 `x-dsh-calendar: write` 头且 `Origin` 是本机（无头则拒），挡掉跨站表单式误触
- `write.enabled: false` / `create.enabled: false` 可分别关掉写回与新建

### 同步节奏

打开面板即拉一次；之后每 **15 秒**轮询一次（页面不可见时不打扰），另外有「刷新」按钮即时拉取。
在 Obsidian 里改完存盘，DSH 这边十几秒内就跟上（host 侧扫描缓存 2.5 秒）。

### 只读扫描的边界

跳过 `node_modules`/`.git`/`.obsidian` 等目录、隐藏目录与符号链接，并**跳过围栏代码块**里的伪任务行；
上限 600 个文件 / 8 MB / 3000 条任务（响应里 `scanned.truncated=true`，页面底部会提示）。
扫描只把解析出的任务行与行号发给页面 —— 除日记摘要外不发送整篇正文。

页面查询参数：`?session=<会话 id>`（面板自动带）· `?root=<绝对路径或 @session>` · `?tasks=0`（整体关掉任务与日记）。

---

## 3. 不用 DSH 也能先看：单文件版

直接双击 `standalone/calendar.html`，或在目录里起个静态服务：

```powershell
# 任选其一
start dsh-calendar\standalone\calendar.html
npx --yes serve dsh-calendar\standalone     # 然后访问 http://localhost:3000/calendar.html
```

可用的查询参数（单文件版与插件内嵌版共用）：

| 参数 | 作用 |
|---|---|
| `?theme=light` / `?theme=dark` | 强制配色，忽略系统偏好 |
| `?embed=1` | 内嵌形态：卡片去掉圆角/最大宽度、页面背景透明（宿主底色透出） |

---

## 4. 装进 DSH（本机 profile：`D:\dsh\home\profiles\web`）

> **本机当前状态：已正式装机（不是运行时注入）。**
> `profiles\web\package.json` 里 `dependencies["dsh-calendar"] = "link:D:\\what's_today\\dsh-calendar"`、
> `dsh.profile.bundles` 末尾加了 `dsh-calendar`、`node_modules\dsh-calendar` 是指向包目录的 junction，
> 注入器的 `registry.json` 已清空（避免重启后与 bundle 双重挂载）。
> `dsh --profile web --dump-config` 能在启动组合树里看到它 → **重启后自动装配，对每个会话都在**。
> 每个对话里的入口：会话 header 右侧的日历图标按钮 + 右侧栏「+」引导胶囊里的「日历」。
>
> **进入会话自动展开**：client 半边在会话 header 坐席里挂了一个副作用——每个会话第一次加载时自动
> `ctx.sidebarRight.openTab('calendar')`，所以新开对话就能直接看到日历。它按会话记账，
> **你手动关掉之后不会再弹回来**；侧栏服务没就绪会退避重试（6 × 400ms），彻底失败则撤销记账留待下次。
> 不想要这个行为：在 `$DSH_HOME/dsh-calendar/config.json` 里加 `"autoOpen": false`（改完即时生效，client 每次读 /status）。

> DSH_HOME 是 `profiles/` 的父目录（本机为 `D:\dsh\home`，可用 `$env:DSH_HOME` 确认）。
> Web 界面对应的 profile 就是 `profiles\web`：`profiles\web\package.json` 的
> `dsh.profile.bundles` 决定挂载哪些 bundle，`profiles\web\cordis.patch.yml` 是用户自己的 patch 层。

### 通道 A：注入器（推荐；本次实测用的就是它，免重启）

在 DSH 会话里让 agent 调用（`dsh-super-injector` 提供）：

```
dev_inject_plugin  D:\what's_today\dsh-calendar
dev_plugin_status                      # 看 fiber=active 与入口 URL
```

它做的事：在 `profiles\web\node_modules\` 下建一个指向本包的 **junction**，用
`loader.create` 运行时装配（host + client 一起生效，浏览器免手动刷新），并把记录写进
`D:\dsh\home\super-injector\registry.json` —— 重启后自动恢复。

卸载：`dev_uninject_plugin dsh-calendar`（或 `match=dsh-calendar`）。
改了 `lib/` 下任何文件：`dev_reload_package dsh-calendar` 即可热重载。

### 通道 B：官方 CLI（持久、可分发）

```powershell
dsh plugin --profile web add "D:\what's_today\dsh-calendar"     # 本地目录
# 或先打包：npm pack  然后  dsh plugin --profile web add .\dsh-calendar-0.1.0.tgz
```

CLI 会 **自动改两处清单**（不需要手工编辑）：

- `profiles\web\package.json` → `dependencies` 加一条（本地目录是 `file:` 引用）
- `profiles\web\package.json` → `dsh.profile.bundles` 数组追加 `"dsh-calendar"`
  （因为本包 `package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，启动时由该 patch 插入插件行）

卸载：`dsh plugin --profile web remove dsh-calendar`。

### 通道 C：纯手工（不想用 CLI 时）

1）让包能被解析 —— 在 `D:\dsh\home\profiles\web\node_modules\` 建 junction：

```powershell
New-Item -ItemType Junction -Path "D:\dsh\home\profiles\web\node_modules\dsh-calendar" `
         -Target "D:\what's_today\dsh-calendar"
```

2）二选一挂载：

- 改 `D:\dsh\home\profiles\web\package.json`，把 `"dsh-calendar"` 追加到
  `dsh.profile.bundles` 数组末尾；**或**
- 在 `D:\dsh\home\profiles\web\cordis.patch.yml`（默认是 `[]`）里手写一行：

  ```yaml
  - insert:
      - id: dsh-calendar
        name: 'dsh-calendar'
  ```

3）重启 `dsh web`（profile 的 `patchReload: live` 通常能省掉这一步）。

### 清单/配置改动速查

| 文件 | 何时需要动 | 改什么 |
|---|---|---|
| `profiles\web\package.json` → `dsh.profile.bundles` | 通道 B/C | 追加 `"dsh-calendar"` |
| `profiles\web\package.json` → `dependencies` | 通道 B | `"dsh-calendar": "file:…"` |
| `profiles\web\cordis.patch.yml` | 通道 C | `insert` 一行插件条目 |
| `super-injector\registry.json` | 通道 A | 注入器自动写，不要手改 |
| 本包 `cordis.patch.yml` | — | 随包发布的挂载行，`dsh plugin add` 自动合并 |

---

## 5. 用起来

三个入口（任选）：

1. **会话 header 的日历图标按钮** —— 一键打开右侧栏的日历 tab（按钮注册在 `conversation.session.header.utilities`）。
2. **右侧栏 tab 条的「+」** → 引导页里出现胶囊 **「日历」** → 点开即得日历面板。
3. 直接访问页面：

```
http://127.0.0.1:3080/dsh-calendar/preview            # 单文件页
http://127.0.0.1:3080/dsh-calendar/preview?theme=dark # 强制深色
http://127.0.0.1:3080/dsh-calendar/preview?embed=1    # 面板内嵌形态（透明底、去卡片）
http://127.0.0.1:3080/dsh-calendar/preview?tasks=0    # 关掉任务与日记
http://127.0.0.1:3080/dsh-calendar/tasks              # 任务 + 日记 JSON（?root= / ?session= / ?refresh=1）
http://127.0.0.1:3080/dsh-calendar/status             # 自检 JSON：页面 + client 半边 + 数据源 + 写权限
POST /dsh-calendar/tasks/toggle                       # 写回一条待办的完成状态（需 x-dsh-calendar: write 头）
POST /dsh-calendar/tasks/update                       # 改写一条待办的正文（同头；带 expect）
POST /dsh-calendar/tasks/schedule                     # 改/清除时间块（Day Planner 的 HH:mm - HH:mm）
POST /dsh-calendar/tasks/add                          # 新建待办（带时间→# Day planner 小节；不带→追加末尾）
POST /dsh-calendar/notes/create                       # 新建某天日记（需同上头；已存在则 409）
```

> 注入后 client 半边由 web 插件表在**页面加载时**注入，已经开着的 DSH 页面要**刷新一次**才会出现入口。
> 面板里显示的就是 `standalone/calendar.html` 这一页（`?embed=1` 形态），不存在第二份实现。
> 任务视图同样住在这一页里：面板把会话 id 交给页面，页面再向 `/dsh-calendar/tasks` 要数据。

## 6. 自检

```powershell
# ① 页面视觉 + 交互（需要本机有 Chrome / Edge；脚本自己起无头浏览器，零 npm 依赖）
node dsh-calendar\scripts\verify-ui.mjs http://127.0.0.1:3080/dsh-calendar/preview .\verify
# → 27/27 checks passed；产物：verify\*.png + verify\report.json

# ② 面板高度自适应（不需要浏览器；从 bundle 抽真代码跑 13 条断言）
node dsh-calendar\scripts\fit-logic.test.mjs .\verify\fit-logic-report.json

# ③ Obsidian Tasks 解析 + 写回改写 + Day Planner 时间块 + 日记识别（从 lib/index.js 抽真代码，127 条断言）
node dsh-calendar\scripts\tasks-parse.test.mjs .\verify\tasks-parse-report.json

# ④ 任务展示 / 时间轴 / 写回交互 / DOM 接线（从 calendar.html 抽真代码，123 条断言）
node dsh-calendar\scripts\tasks-render.test.mjs .\verify\tasks-render-report.json

# ⑤ 自动打开 tab 的记账语义（从 lib/client.js 抽真代码，16 条断言）
node dsh-calendar\scripts\auto-open.test.mjs .\verify\auto-open-report.json

# ⑥ 页面瘦身（零信息损失；只在体积守卫报警时才需要跑）
node dsh-calendar\scripts\slim-page.mjs
```

① 覆盖：42 格 7 列 / 周一起始 / 今日默认蓝圆 / 点击选日后今日转红字 / 箭头·手势·键盘三种切月 /
深色媒体查询 / `?embed=1` / 零外部资源请求 / 无边框无阴影。
② 覆盖：父链无确定高度时**绝不能停在 iframe 默认 150px**、正常 flex/块级父级要撑满、就近取祖先、
CSS 已撑满时不插手、挂载后补量能改口、写入幂等（避免 ResizeObserver 自反馈）、兜底高度 ≥ 页面实测需求。
③ 覆盖：三种勾选态 / 📅⏳🛫 落点优先级 / **Day Planner 时间头（区间与单点、非法时间、不在行首不认）** / 时钟换算 / **改描述保时间、改时间保描述** / 字数统计 / 五档优先级 / 标签 / ✅➕❌ / 🔁 / 正文清洗不留残字 / 非法日期 /
围栏跳过 / **整行改写逐字符断言（含幂等、来回切、关闭 ✅ 模式、非任务行拒绝）** / 文件名日期识别 /
标题模板 / 摘要去 frontmatter·任务·代码块 / 截断。
④ 覆盖：任务点种类与三枚上限 / 排序 / 表头文案 / 元信息 / **紧凑时间轴（±1 小时上下文、折叠空白、现在指示线、按时间排序）** / **时长与时间胶囊文案** / **当天进度** / **Calendar 字数点与悬停文案** / `tasksUrl` 与 `rootQuery` 契约 /
`nextState`·`formatBytes`·`noteSummary`·`writeErrorText` / 所有 `getElementById` 的 id 都在 markup /
内联脚本可编译 / 写回头与 `expect` 都在代码里 / 轮询与新建按钮已接线。

## 7. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 右侧栏「+」里没有「日历」胶囊 | client 半边没装配：看 `dev_plugin_status` 的 fiber 状态；`GET /dsh-calendar/status` 看 `clientModule.registered`；再刷新一次页面 |
| 面板打开是 404 / 纯文字报错 | host 半边没挂上路由：确认 profile 里有 `webServer`（web profile 一定有），并检查 `/dsh-calendar/preview` 是否可达 |
| 面板里只有大标题和星期表头、**没有日期** | 内嵌 iframe 没拿到高度、被压成默认 150px（表头栈正好 154px，网格整片被裁）。已修：正文量高度写像素 + 兜底 430px；复发就跑 `scripts/fit-logic.test.mjs` 并检查坐席容器是否给了确定高度 |
| 日历上没有任务点 | ① 该笔记库里没有带日期的任务行；② `GET /dsh-calendar/tasks?refresh=1` 看 `root` 是否符合预期、`ok`/`error`；③ 任务必须有 📅/⏳/🛫 之一才会出现在月历上 |
| 面板里看不到我的笔记库 | 主数据源 = `$DSH_HOME/dsh-calendar/config.json` 的 `roots[0]`；确认路径存在且 `/status` 的 `workspace.source` 是 `config` |
| 任务来自错误的目录 | 用 `?root=<已配置路径>` 或 `?root=@session` 切换；不在 `roots` 里的路径会被拒（`root-not-allowed`） |
| 点了圆圈没反应 / 提示写回失败 | 看 `/status` 的 `write.enabled`；`stale` = 文件在别处被改过（会提示重试）；`write-failed` = 文件被 Obsidian 占住（存盘后重试）；被拒的写都在 `writes.jsonl` 里没有记录，说明根本没落盘 |
| 面板里显示"未连接 DSH" | 用 `file://` 直接打开单文件页时没有 host 路由 —— 属预期降级；`?tasks=0` 可彻底隐藏任务区 |
| 大笔记库只扫到一部分 | 有上限（600 文件 / 8 MB / 3000 条），响应 `scanned.truncated=true`，页面底部会提示；缩小 `roots` 到具体子目录即可 |
| Obsidian 里改了，DSH 没更新 | 15 秒轮询 + host 侧 2.5 秒缓存；点「刷新」可立即拉取。若仍不动，看 `/tasks` 的 `root` 是否指向你改的那个文件 |
| 时间轴没出来 / 只有未安排列表 | 只有当天的任务里有 `HH:mm` 时间头才会画时间轴；`/tasks` 返回里看该任务的 `startTime` 是否为空 |
| 改时间提示"时间不合法" | 结束时间必须晚于开始时间，格式 `HH:mm`；只填一个时要填**开始**那一格（或让页面自动顶替） |
| 新建待办没进 `# Day planner` 小节 | 只有**带了时间**才写进小节；`config.json` 的 `dayPlanner.heading` 要与你 Obsidian 里的标题一致（默认 `Day planner`） |
| 不想每次进对话都自动弹出日历 | `$DSH_HOME/dsh-calendar/config.json` 里加 `"autoOpen": false`（client 每次读 /status 的开关） |
| 自动弹出被关掉后想再要 | 确认 `autoOpen` 不是 `false`；再刷新页面（同一会话内手动关掉后不会自己弹回，这是故意的） |
| 启动报 `duplicate prefix route` / `duplicate loader entry id` | 同一个包被挂了两次（注入器 + bundles 同时存在）：删掉其中一条，或依赖本包 `cordis.patch.yml` 里的重复挂载守卫 |
| 配色和 DSH 主题不一致 | 面板按 `--dsw-alias-*` 探测主题；若宿主改了变量名，改 `lib/client.js` 的 `PROBE_VARS` |

## 8. 验收清单（自检结果）

- [x] 单文件页可独立打开，无任何网络请求、无边框阴影
- [x] 大标题 / 七列 / 周一起始 / 今日默认蓝色圆选 / 非当月弱化
- [x] 箭头、滑动手势、键盘 `←/→` 三种切月方式
- [x] 点击任意日期即时高亮，标题下说明同步
- [x] 浅色与深色（系统 / `?theme=` / 面板主题三种来源）均正确
- [x] 注入后 `dev_plugin_status` 为 active（`[active] e2417c89 (dsh-calendar) [injected]`）、
      预览路由 200、`/dsh-calendar/status` 报 `clientModule.registered = true` 且给出浏览器真实加载 URL
- [x] 无头断言 27/27 PASS + 6 张截图人工复核（证据在仓库根的 `verify/`）
- [x] 面板高度回归 13/13 PASS（`verify/fit-logic-report.json`）
- [x] 面板 tab 画面由用户实测确认可显示（并据此修掉「无日期」缺陷 —— `verify/07-panel-defect-no-dates.png`）
- [x] Obsidian Tasks 解析 + 写回改写 + 日记识别回归 **93/93 PASS**（`verify/tasks-parse-report.json`）
- [x] 任务展示 / 写回交互 / DOM 接线回归 **72/72 PASS**（`verify/tasks-render-report.json`）
- [x] 写回活体实测（在自有演示笔记上，不碰你的 vault）：过期 `expect` → **409 且文件未变**；
      正确写 → 磁盘出现 `- [x] … ✅ 2026-09-16`；再写一次 `changed:false`（幂等）；取消完成 → `✅` 被移除；
      `../dsh-calendar/README.md`（真实存在但在 root 外）→ **outside-root** 拒绝；非任务行 → `not-a-task`；
      行号越界 → 400；写后整文件 20 条任务仍全部正确解析、围栏陷阱行仍被跳过
- [x] **任务正文改写**活体实测：改完磁盘为 `- [ ] 准备周会材料（改成新的写法） 📅 2026-09-20 ⏫ #work`
      （元数据/优先级/标签一字不差）；空/超长/带换行 → **400**，过期 `expect` → **409**；审计 action=`edit`
      （`verify/edit-live.txt`）
- [x] 新建日记活体实测：无写头 → **403**；带头 → 在 `日历&备忘录\2026-09-16.md` 建出 `# 2026-09-16 星期三`；
      重复新建 → **409 绝不覆盖**；随后 `/tasks` 把它识别为当天日记（`notes=1`）
- [x] 数据源实测：`/status` → `workspace.source = config`、`root = …\日历&备忘录`、两个 root 均 `writable`
- [x] Obsidian 侧配置：`.obsidian/daily-notes.json` 已指向该文件夹（原本不存在，故无 `.bak`）
- [x] 日记归日实测：日记里没写 📅 的待办算作那天（`回寝室睡觉 → 2026-09-16`、`校安协晚上8点面试 → 2026-09-17`，
      均 `source=note`；`undated=0`）
- [x] 界面：背景渐变（页面 + 卡片 + 内嵌面板的 `--cal-wash`）、点击波纹（含 `prefers-reduced-motion` 降级）、
      任务正文可就地编辑（回车/失焦提交、`Esc` 取消）、日记块与任务行**不再显示文件名**、成功操作不弹提示
- [x] **Day Planner 适配**：你 09-19 日记里的 `18:00 - 18:50 吃饭` / `20:10 - 20:50 小平招新` 被正确解析出
      `startTime/endTime/durationMinutes`（`verify/dayplanner-live.txt`）
- [x] **改时间**活体实测：加时间 → `- [ ] 09:30 - 10:00 准备周会材料 📅 2026-09-20 ⏫ #work`；改成 14:15 - 15:45；
      清除回未安排 —— 三次都只动行首时间，`📅 ⏫ #work` 一字未动
- [x] **新建待办**活体实测：带起止时间 → `- [ ] 09:00 - 11:00 写代码`；只给开始 → `- [ ] 12:30 午休`；
      不带时间 → 追加末尾；自动建出日记与 `# Day planner` 小节（与 Day Planner 插件同一种写法）
- [x] 时间护栏：非法小时 / 只给结束 / 结束早于开始 / 空文本 / 非法日期 → 全部 **400**；
      未授权目录 → `root-not-allowed`
- [x] **Calendar 适配**：字数点（每 250 字一枚）+ 日期格悬停文案（`已写 51 词 · 3/8 个任务完成，2 个已排时间`）
- [x] 回归：解析 **127/127**、展示与交互 **120/120**、面板高度 **13/13**
- [x] **正式装机**：profile `dependencies` 加 `link:` + `dsh.profile.bundles` 加 `dsh-calendar` + junction；
      注入器 registry 清空（避免双重挂载）；`dsh --profile web --dump-config` 的启动组合树里能看到它
      （`verify/install.txt`）
- [x] **每个对话自动展开日历**：client 半边按会话记账的自动 `openTab`，手动关掉不弹回；
      回归 **16/16**（`verify/auto-open-report.json`）；服务端真发的 bundle 里含这段逻辑（16481 B）
- [x] 顺带修掉一个假自检：`/status.expectedClientBundle` 原是我猜的 `/plugins/dsh-calendar/client.js`（本来就 404），
      现改为从 client-modules graph row 读**真实 combo URL** 并实测 `HTTP 200 · 16481 B`
- [ ] 时间轴 / 进度条 / 字数点 / 时间编辑器 / 自动弹出的**画面**待你刷新后确认（本会话审批策略为 `never`，无法再启无头浏览器自测）
