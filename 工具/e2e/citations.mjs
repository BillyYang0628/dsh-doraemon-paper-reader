#!/usr/bin/env node
// L2：正文引用蓝链 → 引用预览卡（左目录/右内容）→ 精读承接。
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/citations.mjs --url "http://127.0.0.1:3116/?token=…" --title "Sharing Detailed"

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
const outDir = path.resolve(args.out ?? '工具/gen/citations-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const errors = []
const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-citations-profile'), {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
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
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('doraemonPaperReader.lastJobId')
    } catch {
      // ignore
    }
  })
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
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
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)

  const linkCount = await page.locator('.dpr-citeLink').count()
  if (linkCount === 0) errors.push('阅读页没有生成引用蓝链')
  await mkdir(outDir, { recursive: true })
  await page.locator('.dpr-citeLink').first().click()
  await page.locator('.dpr-citeCard').waitFor({ state: 'visible', timeout: 10000 })
  const navCount = await page.locator('.dpr-citeNav button').count()
  if (navCount !== 3) errors.push('引用预览卡左侧目录不是 3 项：' + navCount)

  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.dpr-candidate').length > 0 ||
        document.querySelectorAll('.dpr-citeChoices button').length > 0 ||
        document.querySelectorAll('.dpr-citeSection').length > 0 ||
        document.querySelectorAll('.dpr-citeWarn').length > 0 ||
        document.querySelectorAll('.dpr-citeCard .dpr-error').length > 0,
      undefined,
      { timeout: 30000 },
    )
    .catch(() => {})
  const groupChoices = page.locator('.dpr-citeChoices button')
  if ((await groupChoices.count()) > 0) {
    await groupChoices.first().click()
    for (let i = 0; i < 45; i += 1) {
      await page.waitForTimeout(1000)
      if (
        (await page.locator('.dpr-citeSection').count()) > 0 ||
        (await page.locator('.dpr-citeWarn').count()) > 0 ||
        (await page.locator('.dpr-citeCard .dpr-error').count()) > 0
      ) {
        break
      }
    }
  }
  const candidates = page.locator('.dpr-candidate')
  if ((await candidates.count()) > 1) {
    await candidates.nth(1).click()
    for (let i = 0; i < 45; i += 1) {
      await page.waitForTimeout(1000)
      if (
        (await page.locator('.dpr-citeSection').count()) > 0 ||
        (await page.locator('.dpr-citeWarn').count()) > 0 ||
        (await page.locator('.dpr-citeCard .dpr-error').count()) > 0
      ) {
        break
      }
    }
  }
  const sections = await page.locator('.dpr-citeSection').count()
  if (sections !== 3) errors.push('引用预览没有生成概览/关系/依据三段：' + sections)

  const beforeScroll = await page.locator('.dpr-citeContent').evaluate((element) => element.scrollTop)
  await page.locator('.dpr-citeNav button', { hasText: '引用关系' }).click()
  await page.waitForTimeout(500)
  const afterScroll = await page.locator('.dpr-citeContent').evaluate((element) => element.scrollTop)
  if (!(afterScroll > beforeScroll)) errors.push('左侧目录点击没有带动右侧内容滚动')

  const deep = page.getByRole('button', { name: '精读这篇', exact: true })
  if (!(await deep.isEnabled().catch(() => false))) errors.push('引用就绪后「精读这篇」仍不可用')
  else {
    await deep.click()
    await page.waitForTimeout(900)
    if (!(await page.locator('.dpr-citeFrom').isVisible().catch(() => false))) {
      errors.push('精读承接页没有显示「来自引用」提示')
    }
    const titleValue = await page.locator('.dpr-lookupField input').first().inputValue().catch(() => '')
    if (!titleValue) errors.push('精读承接页没有预填标题')
  }
  await page.screenshot({ path: path.join(outDir, 'citation-preview.png') })
  console.log(JSON.stringify({ out: outDir, linkCount, navCount, sections, errors }, null, 2))
  if (errors.length) process.exitCode = 1
} finally {
  await context.close()
}
