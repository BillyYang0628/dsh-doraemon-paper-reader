#!/usr/bin/env node
// L2：真实引用预览 → 精读承接 → 查询 → 取回 → 阅读页保留 fromCitation。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/citation-chain.mjs --url "http://127.0.0.1:3117/?token=…" [--title "Smart Sticker"] [--out <dir>]

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--title') out.title = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--headed') out.headless = false
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url')
const outDir = path.resolve(
  args.out ?? '工具/gen/citation-chain-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
)
const errors = []
const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-citation-chain-profile'),
  {
    channel: 'msedge',
    headless: args.headless,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
  },
)
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  await page.waitForTimeout(450)
  return true
}

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1500)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1500)
  }
  await page.locator('.dpr-libraryItem').first().waitFor({ state: 'visible', timeout: 20000 })
  const item = args.title
    ? page.locator('.dpr-libraryItem', { hasText: args.title }).first()
    : page.locator('.dpr-libraryItem').first()
  await item.click()
  await page.locator('.dpr-readerBarTitle').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)

  const links = page.locator('.dpr-citeLink')
  if ((await links.count()) === 0) throw new Error('阅读页没有引用蓝链')
  await links.first().click()
  await page.locator('.dpr-citeCard').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1200)
  // 多候选时先选第一条；后面的查询页还能再选。
  const candidates = page.locator('.dpr-candidate')
  if ((await candidates.count()) > 0) {
    await candidates.first().click()
    await page.waitForTimeout(1200)
  }
  const deep = page.getByRole('button', { name: '精读这篇', exact: true })
  await deep.waitFor({ state: 'visible', timeout: 60000 })
  if (await deep.isEnabled().catch(() => false)) {
    await deep.click()
  } else {
    errors.push('「精读这篇」不可用，引用预览没有就绪')
  }
  await page.waitForTimeout(900)
  const lookupButton = page.getByRole('button', { name: '去找论文', exact: true })
  if (!(await lookupButton.isVisible().catch(() => false))) {
    errors.push('没有进入查询页')
  } else {
    await lookupButton.click()
    await page.waitForTimeout(2500)
  }

  // 查询页可能是 exact / candidates / existing / metadata-only。
  let opened = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fetchButton = page.getByRole('button', { name: '取回并阅读', exact: true })
    if (await fetchButton.isVisible().catch(() => false)) {
      await fetchButton.click()
      await page.waitForTimeout(1500)
      break
    }
    const openExisting = page.getByRole('button', { name: '打开已有本地副本', exact: true })
    if (await openExisting.isVisible().catch(() => false)) {
      await openExisting.click()
      opened = true
      break
    }
    const candidates = page.locator('.dpr-candidate')
    if ((await candidates.count()) > 0) {
      const oa = candidates.filter({ hasText: 'OA' }).first()
      await (oa.count() > 0 ? oa : candidates.first()).click()
      await page.waitForTimeout(2500)
      continue
    }
    await page.waitForTimeout(1000)
  }

  // 取回任务完成后，查询页会出现「打开阅读页」。
  for (let attempt = 0; attempt < 90 && !opened; attempt += 1) {
    const openReader = page.getByRole('button', { name: '打开阅读页', exact: true })
    if (await openReader.isVisible().catch(() => false)) {
      await openReader.click()
      opened = true
      break
    }
    const openExisting = page.getByRole('button', { name: '打开已有本地副本', exact: true })
    if (await openExisting.isVisible().catch(() => false)) {
      await openExisting.click()
      opened = true
      break
    }
    await page.waitForTimeout(1000)
  }

  if (!opened) {
    errors.push('查询页没有打开阅读页（可能只拿到 metadata-only 或网络失败）')
  } else {
    await page.locator('.dpr-readerBarTitle').first().waitFor({ state: 'visible', timeout: 30000 })
    const backButton = page.getByRole('button', { name: /← 引用/ }).first()
    const compareButton = page.getByRole('button', { name: '双篇对照', exact: true }).first()
    const hasBack = await backButton.isVisible().catch(() => false)
    const hasCompare = await compareButton.isVisible().catch(() => false)
    if (!hasBack) errors.push('阅读页工具栏没有「← 引用」返回按钮')
    if (!hasCompare) errors.push('阅读页工具栏没有「双篇对照」按钮')
    await mkdir(outDir, { recursive: true })
    await page.screenshot({ path: path.join(outDir, 'citation-chain-reader.png') })
    console.log('阅读页 fromCitation：' + JSON.stringify({ hasBack, hasCompare }))
  }
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'citation-chain-final.png') })
  console.log('页面 console error：' + (errors.length === 0 ? '无' : errors.join(' || ')))
  console.log('截图：' + outDir)
  if (errors.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
