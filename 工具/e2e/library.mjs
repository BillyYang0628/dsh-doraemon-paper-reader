#!/usr/bin/env node
// B0：文档管理入口与论文库现状基线。

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { cdp: 'http://127.0.0.1:9222' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cdp') out.cdp = argv[++i]
    else if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--profile') out.profile = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(args.out ?? '工具/gen/B0-20261021/library')
let browser
let page
if (args.url) {
  browser = await chromium.launchPersistentContext(path.resolve(args.profile ?? '工具/gen/_b0-library-profile'), {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
  })
  page = browser.pages()[0] ?? (await browser.newPage())
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
} else {
  browser = await chromium.connectOverCDP(args.cdp)
  page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith('dsh-app://'))
}
if (!page) throw new Error('未找到 DSH 页面')

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  return true
}

if (await clickIfVisible('论文阅读器')) await page.waitForTimeout(500)
if (!(await page.locator('.dpr-pane .dpr-card').first().isVisible().catch(() => false))) {
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' }).last()
    if (await entry.isVisible().catch(() => false)) {
      await entry.click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1400)
  }
}
await page.locator('.dpr-pane .dpr-card').first().waitFor({ state: 'visible', timeout: 15000 })
await page.waitForTimeout(1200)

const state = await page.evaluate(() => ({
  libraryEntry: Boolean(
    [...document.querySelectorAll('button, a')].find((element) =>
      String(element.textContent || '').includes('文档管理'),
    ),
  ),
  recentItems: document.querySelectorAll('.dpr-libraryItem').length,
  recentVisible: Boolean(document.querySelector('.dpr-library')),
  buttons: [...document.querySelectorAll('button')]
    .filter((element) => element.getBoundingClientRect().width > 0)
    .map((element) => ({
      text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      aria: element.getAttribute('aria-label'),
    }))
    .filter((item) => item.text || item.aria),
}))

const report = {
  generatedAt: new Date().toISOString(),
  expectedFeature: 'R-021 document management entry and batch import page',
  status: state.libraryEntry ? 'entry-present' : 'missing-feature-baseline',
  ...state,
}
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
await browser.close()
