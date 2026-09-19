# dsh-calendar · 把 Obsidian 内联进 DSH

[![CI](https://github.com/AloneFu/dsh-calendar-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/AloneFu/dsh-calendar-plugin/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 DeepSeek Harness 的**右侧栏**里打开你的 Obsidian 日记：月历、当天时间轴（Day Planner 风格）、
待办列表与日记正文，勾选完成 / 改内容 / 改时间都会**写回你的 Markdown 原文件**。

- 零运行时依赖：host 半边只用 Node 内建模块，client 半边只用平台自带的 React
- 单文件真源：日历页是一个零依赖 HTML（`standalone/calendar.html`），面板只是把它内嵌进来
- 只读扫描 + 受控写回：默认只在你自己指定的文件夹里活动，写回带乐观并发与审计

---

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| **Obsidian**（必需） | 插件不依赖 Obsidian 在运行 —— 它直接读你 vault 里的 Markdown，Obsidian 只是你平时编辑的地方 |
| **Day Planner**（建议） | 有它才有 `HH:mm - HH:mm` 时间块；本插件会读它的配置（`startHour` / `defaultDurationMinutes` / `showNow`）并把时间块画成当天时间轴。**没装也能用**，只是没有时间轴 |
| **Calendar**（建议） | Liam Cain 的 Calendar；本插件会读它的 `wordsPerDot`，在日期格里画"日记字数点"。没装就用默认 250 字一个点 |
| **Obsidian Tasks 语法**（兼容） | `- [ ] 任务 📅 2026-09-19 ⏫ #tag` 这类行会被解析成待办；`📅`/`⏳`/`🛫` 决定它落在哪一天 |

> 这三个 Obsidian 插件**不是硬依赖**。装上是为了两边显示一致；不装也能正常看日记、勾待办。

## 2. 安装

**方式一：DSH 插件市场** —— 搜索 `dsh-calendar` 安装。

**方式二：用 tgz 安装**

```powershell
dsh plugin --profile web add "<路径>\dsh-calendar-1.0.0.tgz"
# 然后重启 DSH；或让 AI 用 dev_install_package 热装配（免重启）
```

**方式三：从 git 仓库**（本仓库就是完整的插件包）

```powershell
git clone https://github.com/AloneFu/dsh-calendar-plugin.git D:\plugins\dsh-calendar
dsh plugin --profile web add "D:\plugins\dsh-calendar"
# 或手动：dependencies 写 "dsh-calendar": "link:D:\plugins\dsh-calendar" + bundles 加 dsh-calendar
```

想自己出 tgz：在克隆下来的目录里跑 `node scripts/pack.mjs`（5 套回归 → 体积守卫 → 产物在 `dist/`）。

**方式四：手动挂载**

1. 把包解开放到任意目录，例如 `D:\plugins\dsh-calendar`
2. `profiles\<profile>\package.json` 的 `dependencies` 加 `"dsh-calendar": "link:D:\\plugins\\dsh-calendar"`
3. 同一文件的 `dsh.profile.bundles` 数组末尾加 `"dsh-calendar"`
4. 在该 profile 目录执行 `pnpm install`（建立 `node_modules` 链接），重启 DSH

## 3. 首次使用（30 秒）

1. 打开 DSH 右侧栏，点「+」里的 **日历**，或点会话 header 右侧的 **日历图标**
2. 面板会显示 **连接 Obsidian**：
   - 点 **「自动寻找」**：插件在常见位置（`Documents`、`Desktop`、各盘根目录等，最多下探两层）找带 `.obsidian` 的目录，
     读出它的 **Daily Notes 文件夹**（`.obsidian/daily-notes.json`）并作为建议值填给你
   - 或者**手动填**你的日记文件夹路径（Obsidian 里存 `2026-09-19.md` 这类文件的目录）
3. 点 **「保存并开始使用」**：立刻生效，不用重启

保存后写入 `$DSH_HOME/dsh-calendar/config.json`（`DSH_HOME` 默认 `~/.dsh`）。想改随时改这个文件，或再进一次向导。

## 4. 让 AI 帮你自动配置（预留接口）

本插件自带**给 AI/命令行**的接口，AI 不需要预先知道你的 vault 在哪，就能自己找到并配好。

把下面这段直接发给你在 DSH 里的 AI：

> 用 `dsh-calendar` 插件自带的安装接口帮我配好 Obsidian：
> 1. `node <插件目录>/scripts/setup.mjs --detect --json` 找出本机 vault；
> 2. 从候选里选一个（通常用它的 `root` 字段），执行 `node <插件目录>/scripts/setup.mjs --root "<那个 root>"`；
> 3. `curl "http://127.0.0.1:3080/dsh-calendar/tasks?refresh=1"` 自检，确认 `root` 与 `notes` 计数正常；
> 4. 告诉我结果（配到了哪个文件夹、读到几篇日记）。

**命令行接口**（`scripts/setup.mjs`，与面板向导共用同一套实现，不需要 DSH 在运行）：

```bash
node scripts/setup.mjs --print                # 打印当前配置（含 DSH 家目录来源）
node scripts/setup.mjs --detect               # 人看的候选列表
node scripts/setup.mjs --detect --json        # AI 解析用的 JSON
node scripts/setup.mjs --root "<路径>"        # 配为主数据源
node scripts/setup.mjs --print --dsh-home "<DSH_HOME>"   # 显式指定 DSH 家目录
```

> **关于 `DSH_HOME`**：CLI 用它决定配置文件写哪儿（没设就兜底 `~/.dsh`，此时会打印一条 ⚠ 提醒）。
> 如果你的 shell / AI 沙箱里没有这个环境变量，请加 `--dsh-home "<DSH_HOME>"`；
> 或者更稳的办法：`curl http://127.0.0.1:3080/dsh-calendar/status` 看里面的 `configPath`
> —— 正在运行的插件给出的路径永远是最准的（它以运行进程的环境为准）。

`--detect --json` 的返回形状：

```json
{
  "ok": true,
  "count": 1,
  "detected": [
    {
      "name": "Obsidian Vault",
      "vault": "C:\\Users\\me\\Documents\\Obsidian Vault",
      "root": "C:\\Users\\me\\Documents\\Obsidian Vault\\日记",
      "dailyFolder": "日记",
      "hasDailyConfig": true,
      "dateFormat": "YYYY-MM-DD",
      "dayPlanner": { "installed": true, "timelineDateFormat": "YYYY-MM-DD", "startHour": 6 },
      "calendar": { "installed": true, "wordsPerDot": 250 }
    }
  ]
}
```

**HTTP 接口**（插件运行中可用；写操作需要 `x-dsh-calendar: write` 头且来源为本机）：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-calendar/setup` | 配置状态；`?detect=1` 时附候选列表 |
| `POST` | `/dsh-calendar/setup` | 保存日记文件夹（`{ "root": "..." }`） |
| `GET` | `/dsh-calendar/tasks` | 任务 + 日记 JSON（`?refresh=1` 强刷） |
| `POST` | `/dsh-calendar/tasks/toggle` | 切换完成状态 |
| `POST` | `/dsh-calendar/tasks/update` | 改任务内容 |
| `POST` | `/dsh-calendar/tasks/schedule` | 改/清除时间块 |
| `POST` | `/dsh-calendar/tasks/add` | 新建待办 |
| `POST` | `/dsh-calendar/notes/create` | 新建某天日记 |
| `GET` | `/dsh-calendar/status` | 自检：路由、配置、client 模块与真实加载 URL |

## 5. 功能

| 区域 | 做什么 |
|---|---|
| **月历** | iOS 视觉（大标题、七列、周一起始、今日高亮、圆角卡片、无边框无阴影）；箭头 / 滑动 / `←→` 切月 |
| **日期格** | 灰色**字数点**（每 `wordsPerDot` 字一枚）+ 彩色**任务点**（逾期红 / 高优橙 / 待办蓝 / 完成灰）；悬停看 `已写 N 词 · x/y 个任务完成` |
| **当天时间轴** | `HH:mm - HH:mm` 时间块按小时排布；**「现在」红线**（今天）；空白小时折叠成"⋯ N 小时无安排"；上方有**完成进度条** |
| **任务列表** | 没排时间的任务归到「未安排」；状态字形 ○/✓/✕、`#tag` 高亮、优先级/重复/落点/逾期标注 |
| **日记** | 文件名带日期即认作当天日记（`2026-09-19` / `2026年9月19日` / `2026.09.19` / `20260919`）；折叠块看正文摘要；没有时可一键新建 |
| **写回** | ① 点圆圈标完成（追加 `✅ YYYY-MM-DD`）② 点正文改内容（只换描述，元数据原样保留）③ 点时间胶囊改/清除时间 ④ 底部输入框新建待办（带时间自动写进 `# Day planner` 小节） |
| **同步** | 15 秒轮询 + host 侧 2.5 秒缓存；也有「刷新」按钮 |

## 6. 写回安全

会动你文件的地方只有"写回"这一条路，护栏如下：

- **只在配置的文件夹内**：`realpath` 校验，`../` 与符号链接逃逸会被拒（`outside-root`）
- **乐观并发**：每次写都带"客户端看到的那一行原文"，与磁盘不符 → **409 且一个字节都不写**
- **原子写**：同目录临时文件 + `rename` 覆盖；写完**回读校验**；保留原编码（BOM）与换行风格（CRLF/LF）
- **逐行最小改动**：只动目标行的勾选框 / 描述 / 时间头，行内其它内容（缩进、项目符号、`📅⏳🛫`、优先级、`#tag`）原样保留
- **审计**：每次写追加到 `$DSH_HOME/dsh-calendar/writes.jsonl`（**不进你的 vault**），含 before/after
- **同一文件串行写**，避免并发读改写互相覆盖
- 不想让它写：`config.json` 里 `"write": { "enabled": false }`

## 7. 配置项（`$DSH_HOME/dsh-calendar/config.json`）

```json
{
  "roots": ["C:\\Users\\me\\Documents\\Obsidian Vault\\日记"],
  "allowAnyRoot": false,
  "autoOpen": true,
  "write": { "enabled": true, "appendDoneDate": true },
  "create": { "enabled": true, "titleTemplate": "# {date} {weekday}" },
  "dayPlanner": { "heading": "Day planner", "headingLevel": 1, "startHour": 6,
                  "defaultDurationMinutes": 30, "minimalDurationMinutes": 10,
                  "snapStepMinutes": 10, "showNow": true, "showNext": true },
  "calendar": { "wordsPerDot": 250, "maxNoteDots": 2 }
}
```

| 键 | 作用 |
|---|---|
| `roots` | 数据源，**第一个是主数据源**；最多保留 3 个（新加的排最前） |
| `allowAnyRoot` | 是否允许 `?root=` 传任意绝对路径（默认 `false`：只认 `roots` 与 DSH 已注册工作区） |
| `autoOpen` | 进入会话时自动展开日历 tab（默认 `true`；手动关掉后同一会话不会弹回来） |
| `write.enabled` | 关掉后完全只读 |
| `write.appendDoneDate` | 标完成时是否追加 `✅ YYYY-MM-DD`（关掉则只翻 `[ ]`↔`[x]`） |
| `create` | 是否允许在 DSH 里新建日记 / 待办 |
| `dayPlanner.*` | 与 Obsidian 的 Day Planner 对齐（标题、起始小时、默认时长…） |
| `calendar.wordsPerDot` | 与 Obsidian 的 Calendar 对齐（每多少字一个点） |

## 8. 排错

| 现象 | 处理 |
|---|---|
| 面板一直显示「连接 Obsidian」 | 还没保存过路径：填一个存在的文件夹后保存；或点「自动寻找」 |
| 自动寻找找不到 | 你的 vault 不在常见位置：手动填路径（含 `.obsidian` 的是 vault；填日记子文件夹更好） |
| 保存报"不能选整块盘" | 出于安全，整盘根目录 / `Windows` / `Program Files` / `AppData` / 用户主目录本身会被拒绝，请选具体文件夹 |
| 月历上没有任务点 | 任务行要有 `📅`/`⏳`/`🛫` 日期才上月历；**日记里没有日期的待办会算作当天**，其它文件里的无日期任务只进"未排期"计数 |
| 时间轴没出来 | 当天任务要有 `HH:mm` 时间头；`/dsh-calendar/tasks` 里看 `startTime` 是否为空 |
| 勾选/改内容没生效 | 看 `/dsh-calendar/status` 的 `write.enabled`；`stale` = 文件在别处被改过（会提示重试）；`write-failed` = 文件被 Obsidian 占住（存盘后重试） |
| 不想每次自动弹出日历 | `config.json` 里 `"autoOpen": false` |
| 面板空白 / 只有标题 | iframe 高度没拿到：刷新页面；仍不行请附 `/dsh-calendar/status` 输出反馈 |

## 9. 卸载

```powershell
dsh plugin --profile web remove dsh-calendar   # 用官方 CLI 装的
# 手动装的就反过来：删 bundles 条目 + 删依赖 + pnpm install + 重启
```

配置与审计在 `$DSH_HOME/dsh-calendar/`，可自行删除。**插件不会改你的笔记结构**（只在原行上改勾选框/描述/时间）。

## 10. 兼容性与实现

- Node ≥ 20（host 半边）；client 半边跑在 DSH web 客户端，只用平台自带的 `react`
- 以 DSH 的 bundle 约定装配：`package.json` 的 `dsh.bundle.patch`（`cordis.patch.yml`）+ `dsh.client.platform = "web"`，客户端导出 `./client`
- 自检：`npm test`（5 套回归，不需要浏览器）；`npm run setup`（自动找 vault）
- 完整实测证据、回归说明与开发记录见 **[DEVELOPMENT.md](DEVELOPMENT.md)**

## 许可

MIT
