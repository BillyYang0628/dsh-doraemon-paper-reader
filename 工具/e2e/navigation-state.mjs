#!/usr/bin/env node
// B0：阅读页 sticky 目录与 tab 切换后 scrollTop 基线。
// 通过 Electron CDP 运行，不改业务数据。

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
    else if (argv[i] === '--title') out.title = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.title) throw new Error('必须给 --title（用于从论文库点开）')
const outDir = path.resolve(args.out ?? '工具/gen/B0-20261021/navigation')
let browser
let page
if (args.url) {
  browser = await chromium.launchPersistentContext(path.resolve(args.profile ?? '工具/gen/_b0-navigation-profile'), {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1920, height: 1080 },
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

async function openHome() {
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
}

async function openReaderByTitle() {
  const item = page.locator('.dpr-libraryItem', { hasText: args.title }).first()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.locator('.dpr-readerLayout').waitFor({ state: 'visible', timeout: 30000 })
}

async function metrics() {
  return page.evaluate(() => {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('.dpr-readerPane, .dpr-readerPane *')]
      .filter(Boolean)
      .filter((element) => element.scrollHeight > element.clientHeight + 20)
      .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))
    const pane = candidates[0] || document.querySelector('.dpr-readerPane')
    const bar = document.querySelector('.dpr-readerBar')
    const outline = document.querySelector('.dpr-readerOutline')
    const body = document.querySelector('.dpr-readerBody')
    const layout = document.querySelector('.dpr-readerLayout')
    const visiblePane = document.querySelector('.dpr-pane')
    const rect = (element) => element?.getBoundingClientRect() || null
    return {
      scrollTop: pane?.scrollTop ?? null,
      paneClientHeight: pane?.clientHeight ?? null,
      paneScrollHeight: pane?.scrollHeight ?? null,
      scrollElement: pane
        ? [pane.tagName?.toLowerCase(), String(pane.className || '').trim().replace(/\s+/g, '.')].filter(Boolean).join('.')
        : '',
      barBottom: rect(bar)?.bottom ?? null,
      outlineTop: rect(outline)?.top ?? null,
      outlineBottom: rect(outline)?.bottom ?? null,
      readerBodyWidth: rect(body)?.width ?? null,
      readerLayoutWidth: rect(layout)?.width ?? null,
      visiblePaneWidth: rect(visiblePane)?.width ?? null,
    }
  })
}

await openHome()
await openReaderByTitle()
await page.waitForTimeout(500)
await mkdir(outDir, { recursive: true })
await page.screenshot({ path: path.join(outDir, 'reader-wide.png') })
const initial = await metrics()
await page.evaluate(() => {
  const candidates = [document.scrollingElement, ...document.querySelectorAll('.dpr-readerPane, .dpr-readerPane *')]
    .filter(Boolean)
    .filter((element) => element.scrollHeight > element.clientHeight + 20)
    .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))
  const target = candidates[0]
  if (target) target.scrollTop = Math.min(1400, Math.max(700, target.scrollHeight * 0.35))
})
await page.waitForTimeout(350)
const scrolled = await metrics()

await openHome()
await openReaderByTitle()
await page.waitForTimeout(800)
const reopened = await metrics()

const findings = []
if (initial.outlineTop !== null && initial.barBottom !== null && initial.outlineTop + 1 < initial.barBottom) {
  findings.push('R-014: initial outline starts above reader bar bottom')
}
if (scrolled.outlineTop !== null && scrolled.barBottom !== null && scrolled.outlineTop + 1 < scrolled.barBottom) {
  findings.push('R-014: scrolled sticky outline is obscured by reader bar')
}
if (
  initial.readerBodyWidth !== null &&
  initial.visiblePaneWidth !== null &&
  initial.readerBodyWidth + 48 < initial.visiblePaneWidth
) {
  findings.push('R-010: reader body leaves avoidable blank width')
}
if (scrolled.scrollTop && reopened.scrollTop !== null && Math.abs(reopened.scrollTop - scrolled.scrollTop) > 120) {
  findings.push('R-015: reader scrollTop was not restored after leaving and reopening')
}

const report = {
  generatedAt: new Date().toISOString(),
  title: args.title,
  initial,
  scrolled,
  reopened,
  findings,
}
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
if (findings.length) process.exitCode = 1
await browser.close()
