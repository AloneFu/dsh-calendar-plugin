#!/usr/bin/env node
/**
 * setup.mjs — dsh-calendar 的安装接口（给人用，也给 AI 用）
 *
 * 这个脚本和插件里的 HTTP `/dsh-calendar/setup` 共用同一套实现（lib/index.js 的 __setup 导出），
 * 所以无论哪条路配置出来的结果都一样。它**不需要 DSH 正在运行**。
 *
 * 用法：
 *   node scripts/setup.mjs --print                  打印当前配置
 *   node scripts/setup.mjs --detect                 列出本机找到的 Obsidian vault 与建议的日记文件夹
 *   node scripts/setup.mjs --root "<路径>"          把该路径设为主数据源（写 $DSH_HOME/dsh-calendar/config.json）
 *   node scripts/setup.mjs --detect --json          机器可读输出（方便 AI 解析）
 *
 * 给 AI 的推荐流程：
 *   1) `node scripts/setup.mjs --detect --json` 拿到候选列表（含 vault / dailyFolder / dayPlanner / calendar 信息）
 *   2) 选一个候选（通常 root 字段就是要配的日记文件夹），执行 `--root "<候选.root>"`
 *   3) `curl http://127.0.0.1:3080/dsh-calendar/tasks?refresh=1` 自检（应看到 root 与 notes/tasks 计数）
 *
 * 退出码：0 = 成功；1 = 参数错或校验失败。
 */

import { __setup } from '../lib/index.js'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null
}
const asJson = has('--json')

// --dsh-home：在没有 DSH_HOME 环境变量的 shell 里（例如某些 AI 沙箱）显式指定 DSH 家目录。
// 必须在调用 __setup.* 之前设置 —— 那些函数是懒执行的，读的就是这个环境变量。
const dshHomeArg = valueOf('--dsh-home')
if (dshHomeArg) process.env.DSH_HOME = dshHomeArg

function out(text) {
  if (!asJson) console.log(text)
}

function fail(message, extra) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message, ...(extra || {}) }, null, 2))
  else console.error('✗ ' + message)
  process.exit(1)
}

async function main() {
  if (has('--help') || argv.length === 0) {
    console.log(`dsh-calendar 安装接口

  node scripts/setup.mjs --print                 打印当前配置
  node scripts/setup.mjs --detect                在本机常见位置找 Obsidian vault
  node scripts/setup.mjs --root "<路径>"         把该路径设为主数据源
  node scripts/setup.mjs --detect --json         机器可读输出（给 AI 用）

配置文件：${__setup.configPath()}`)
    return
  }

  if (has('--print')) {
    const config = await __setup.readConfig()
    const home = await __setup.dshHomeInfo()
    const state = {
      ok: true,
      dshHome: home.home,
      dshHomeSource: home.source,
      looksLikeDshHome: home.looksLikeDshHome,
      configPath: __setup.configPath(),
      roots: (config && config.roots) || [],
      write: (config && config.write) || null,
      create: (config && config.create) || null,
      autoOpen: config ? config.autoOpen !== false : true,
      dayPlanner: (config && config.dayPlanner) || null,
      calendar: (config && config.calendar) || null,
    }
    if (asJson) console.log(JSON.stringify(state, null, 2))
    else {
      out('DSH 家目录：' + state.dshHome + (state.dshHomeSource === 'env' ? '（来自 DSH_HOME 环境变量）' : '（兜底：~/.dsh —— 没读 DSH_HOME）'))
      if (!state.looksLikeDshHome) out('  ⚠ 这个目录里没有 profiles/ 或 storages/，可能不是 DSH 真正的家目录：')
      if (!state.looksLikeDshHome) out('     DSH 正在运行的话，用 `curl http://127.0.0.1:3080/dsh-calendar/status` 看里面的 configPath 更准；')
      if (!state.looksLikeDshHome) out('     或者加 --dsh-home "<DSH_HOME>" 显式指定。')
      out('配置文件：' + state.configPath)
      out('数据源（roots，第一个是主数据源）：')
      out(state.roots.length ? state.roots.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : '  （还没配置 —— 用 --detect 或 --root 配一个）')
      out('写回：' + JSON.stringify(state.write) + '   新建：' + JSON.stringify(state.create) + '   自动打开：' + state.autoOpen)
    }
    return
  }

  if (has('--detect')) {
    const detected = await __setup.detectVaults()
    if (asJson) {
      console.log(JSON.stringify({ ok: true, count: detected.length, detected }, null, 2))
    } else if (detected.length === 0) {
      out('没在本机常见位置找到 Obsidian vault（判据：目录里有 .obsidian）。')
      out('可以手动指定：node scripts/setup.mjs --root "<你的日记文件夹>"')
    } else {
      out(`找到 ${detected.length} 个 vault：`)
      for (const item of detected) {
        out(`  • ${item.name}`)
        out(`      vault      : ${item.vault}`)
        out(`      建议数据源 : ${item.root}`)
        out(`      Daily Notes: ${item.hasDailyConfig ? `'${item.dailyFolder || '（vault 根）'}' (${item.dateFormat})` : '未配置'}`)
        out(`      Obsidian 插件: Day Planner=${item.dayPlanner.installed ? '有' : '无'}  Calendar=${item.calendar.installed ? '有' : '无'}`)
      }
      out('')
      out(`直接采用第一个：node scripts/setup.mjs --root "${detected[0].root}"`)
    }
    return
  }

  const root = valueOf('--root')
  if (root === null) fail('未知参数。用 --help 看用法。')
  const checked = await __setup.validateRootPath(root)
  if (checked.error) fail('路径不可用：' + checked.error, { path: root })
  const next = await __setup.writeConfigRoot(checked.root)
  if (asJson) {
    console.log(JSON.stringify({ ok: true, root: checked.root, roots: next.roots, configPath: __setup.configPath() }, null, 2))
  } else {
    out('✓ 已配置为主数据源：' + checked.root)
    out('  roots = ' + next.roots.join(' · '))
    out('  回到 DSH 的右侧栏日历刷新一下即可看到日记与待办。')
  }
}

main().catch((error) => fail(String((error && error.message) || error)))
