# 更新日志

## 1.0.0 — 首个正式发布

**首次使用向导（本版核心）**
- 面板打开时若还没配置，显示「连接 Obsidian」向导：**自动寻找**本机 vault（常见位置下探两层找 `.obsidian`），
  读出其 Daily Notes 文件夹作为建议值；也可手动填路径
- 保存即生效（写 `$DSH_HOME/dsh-calendar/config.json`，与面板/CLI/HTTP 共用同一实现）
- 路径校验：不存在的路径、整盘根目录、系统目录、用户主目录本身一律拒绝（防全盘扫描 + 防误写）

**给 AI / 命令行的预留接口**
- `scripts/setup.mjs`：`--print` / `--detect [--json]` / `--root "<路径>"`
- HTTP：`GET|POST /dsh-calendar/setup`（写操作需 `x-dsh-calendar: write` 头 + 本机来源）
- README 内含可直接发给 AI 的自动配置指令

**Obsidian 集成**
- 与 **obsidian-day-planner** 对齐：`HH:mm - HH:mm` / 单点 `HH:mm` 时间块、紧凑时间轴、`现在`红线、
  完成进度条、`# Day planner` 小节写入、读其 `startHour` / `defaultDurationMinutes` / `showNow`
- 与 **calendar**（Liam Cain）对齐：日期格字数点（`wordsPerDot`）+ 悬停 `已写 N 词 · x/y 个任务完成`
- Obsidian Tasks 语法：`- [ ]/[x]/[-]`、`📅⏳🛫➕✅❌🔁`、`⏫🔼🔽⏬🔺`、`#tag`
- 日记识别：`2026-09-19` / `2026年9月19日` / `2026.09.19` / `20260919`；日记里没写日期的待办算作当天

**写回（双向同步）**
- 勾选完成（可选追加 `✅ YYYY-MM-DD`）、改任务内容、改/清除时间、新建待办与日记
- 乐观并发（`expect` 不符 → 409 不写）、原子写 + 回读校验、`realpath` 越界拦截、逐行最小改动、
  同文件串行写、审计日志 `writes.jsonl`

**界面**
- iOS 视觉月历（周一起始、今日高亮、无边框阴影）；背景渐变；点击波纹；任务正文就地编辑
- 进入会话自动展开日历 tab（按会话记账，手动关掉不弹回）

**工程**
- 5 套零依赖回归脚本（312 项断言）+ 页面体积守卫（< 64KB，配合交付 gate 的 UTF-8 头切片校验）
- 打包脚本 `scripts/pack.mjs`：同步到独立交付目录 → 跑回归 → 体积守卫 → `npm pack`
