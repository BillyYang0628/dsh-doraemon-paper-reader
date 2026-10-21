#!/usr/bin/env node
// 在系统 Edge 中打开一个真实的本地 DSH 实例，并停在本插件的指定页面。
// 浏览器关闭后脚本自然退出；适合人工查看，不替代自动化验收。

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { target: 'main', clearJob: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--target') out.target = argv[++i]
    else if (argv[i] === '--profile') out.profile = argv[++i]
    else if (argv[i] === '--clear-job') out.clearJob = true
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url')
if (!['main', 'pdf', 'lookup'].includes(args.target)) {
  throw new Error('--target 只支持 main / pdf / lookup')
}

const profileDir = path.resolve(args.profile ?? '工具/gen/_manual-open-profile')
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})

if (args.clearJob) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('doraemonPaperReader.lastJobId')
    } catch {
      // Ignore storage restrictions.
    }
  })
}

const page = context.pages()[0] ?? (await context.newPage())
await page.goto(args.url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  return true
}

if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
for (let attempt = 0; attempt < 2; attempt += 1) {
  if (await clickIfVisible('新标签页')) await page.waitForTimeout(600)
  const entry = page.getByRole('button', { name: '论文阅读器' }).last()
  if ((await entry.count()) > 0) {
    await entry.click()
    break
  }
  if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1400)
}

await page.locator('.dpr-pane .dpr-card').first().waitFor({ state: 'visible', timeout: 20000 })
if (args.target === 'pdf') {
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.locator('.dpr-pageTopbar').waitFor({ state: 'visible', timeout: 15000 })
} else if (args.target === 'lookup') {
  await page.locator('.dpr-pane .dpr-card').nth(1).click()
  await page.locator('.dpr-lookup').waitFor({ state: 'visible', timeout: 15000 })
}

console.log('LOCAL_DSH_PLUGIN_READY target=' + args.target)
await new Promise((resolve) => context.once('close', resolve))
