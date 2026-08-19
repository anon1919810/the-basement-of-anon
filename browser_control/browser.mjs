#!/usr/bin/env node
/**
 * browser.mjs — soyorin 的浏览器操作工具（基于 Playwright）
 *
 * 用法：
 *   node browser.mjs shot <url> [out.png] [waitMs] [--full]
 *       打开页面 → 等待 → 截图 → 关闭
 *   node browser.mjs run <url> <actions.json>
 *       打开页面 → 按动作序列操作（点击/输入/按键/求值/截图）→ 输出 JSON 结果
 *   node browser.mjs run <url> --actions "click #btn; type #q 你好; press Enter; shot out.png"
 *       简化版：用分号分隔的文本动作
 *
 * actions.json 动作格式（数组）：
 *   {"act":"goto","url":"..."}                    跳转
 *   {"act":"click","sel":"#btn","text":"文字"}    点击（sel 或 text 二选一）
 *   {"act":"type","sel":"#q","text":"..."}        输入文字（清空后输入）
 *   {"act":"press","key":"Enter"}                 按键（Enter/Escape/Tab/...）
 *   {"act":"wait","ms":800}                       等待毫秒
 *   {"act":"shot","file":"out.png","full":false}  截图（full=true 整页）
 *   {"act":"eval","js":"document.title"}          执行 JS，返回结果
 *   {"act":"select","sel":"#cat","value":"2"}     下拉选择
 *   {"act":"scroll","y":600}                      滚动
 *   {"act":"text","sel":"#out"}                   读取元素文本
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const headless = !process.argv.includes('--show')

async function runActions(page, actions) {
  const results = []
  for (const a of actions) {
    const t0 = Date.now()
    try {
      switch (a.act) {
        case 'goto':
          await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
          results.push({ act: a.act, ok: true, ms: Date.now() - t0 })
          break
        case 'click': {
          let loc = a.sel ? page.locator(a.sel) : page.getByText(a.text, { exact: false })
          await loc.first().click({ timeout: 15000 })
          results.push({ act: a.act, sel: a.sel ?? a.text, ok: true })
          break
        }
        case 'type': {
          const loc = page.locator(a.sel)
          await loc.first().click({ timeout: 10000 })
          await page.keyboard.press('ControlOrMeta+A')
          await page.keyboard.type(a.text, { delay: 15 })
          results.push({ act: a.act, sel: a.sel, ok: true })
          break
        }
        case 'press':
          await page.keyboard.press(a.key)
          results.push({ act: a.act, key: a.key, ok: true })
          break
        case 'wait':
          await page.waitForTimeout(a.ms ?? 800)
          results.push({ act: a.act, ms: a.ms ?? 800, ok: true })
          break
        case 'shot':
          await page.screenshot({ path: a.file, fullWidth: !!a.full })
          results.push({ act: a.act, file: a.file, ok: true })
          break
        case 'eval':
          results.push({ act: a.act, value: await page.evaluate(a.js) })
          break
        case 'select':
          await page.selectOption(a.sel, a.value)
          results.push({ act: a.act, sel: a.sel, value: a.value, ok: true })
          break
        case 'scroll':
          await page.evaluate((y) => window.scrollTo(0, y), a.y ?? 600)
          results.push({ act: a.act, ok: true })
          break
        case 'text':
          results.push({ act: a.act, sel: a.sel, value: (await page.locator(a.sel).first().textContent())?.trim() ?? '' })
          break
        default:
          results.push({ act: a.act ?? '?', ok: false, error: '未知动作' })
      }
    } catch (err) {
      results.push({ act: a.act ?? '?', sel: a.sel, ok: false, error: String(err).slice(0, 300) })
    }
  }
  return results
}

// 简化文本动作：click #sel / type #sel 文本 / press Enter / wait 800 / shot f.png / eval js
function parseSimple(str) {
  return str.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\w+)\s+(.*)$/)
    if (!m) return { act: 'wait', ms: 500 }
    const [_, act, rest] = m
    if (act === 'click') return { act, sel: rest.trim() }
    if (act === 'press') return { act, key: rest.trim() }
    if (act === 'wait') return { act, ms: Number(rest) || 800 }
    if (act === 'shot') return { act, file: rest.trim() }
    if (act === 'eval') return { act, js: rest.trim() }
    if (act === 'scroll') return { act, y: Number(rest) || 600 }
    if (act === 'text') return { act, sel: rest.trim() }
    if (act === 'type') {
      const sp = rest.indexOf(' ')
      const sel = sp > 0 ? rest.slice(0, sp) : rest
      const text = sp > 0 ? rest.slice(sp + 1).replace(/^"(.*)"$/, '$1') : ''
      return { act, sel, text }
    }
    return { act: 'wait', ms: 500 }
  })
}

const [, , mode, arg1, arg2, arg3] = process.argv

const browser = await chromium.launch({ headless })

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  if (mode === 'shot') {
    const url = arg1
    const out = arg2 ?? 'shot.png'
    const waitMs = Number(arg3 ?? 2000)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(waitMs)
    await page.screenshot({ path: out, fullWidth: process.argv.includes('--full') })
    console.log(JSON.stringify({ ok: true, url, shot: out, title: await page.title() }))
  } else if (mode === 'run') {
    const url = arg1
    let actions
    const ai = process.argv.indexOf('--actions')
    if (ai > 0) {
      actions = parseSimple(process.argv[ai + 1])
    } else if (arg2 && arg2.endsWith('.json')) {
      actions = JSON.parse(readFileSync(arg2, 'utf8'))
    } else {
      actions = [{ act: 'shot', file: arg2 ?? 'shot.png' }]
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    const results = await runActions(page, actions)
    console.log(JSON.stringify({ ok: true, url, title: await page.title(), results }))
  } else {
    console.log(JSON.stringify({ ok: false, error: '用法: shot <url> [png] [ms] | run <url> <actions.json|--actions "..">' }))
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err).slice(0, 500) }))
} finally {
  await browser.close()
}
