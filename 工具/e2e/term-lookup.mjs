#!/usr/bin/env node
// L2：单篇 + 双篇论文术语即时查词，不产生批注或生词记录。
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
const url = args[args.indexOf('--url') + 1]
const out = path.resolve(args[args.indexOf('--out') + 1] || '工具/gen/term-lookup-20261020')
const cdp = args.includes('--cdp') ? args[args.indexOf('--cdp') + 1] : ''
if (!url && !cdp) throw new Error('必须给 --url 或 --cdp')
const errors = []
const findings = []

const disposableContext = cdp
  ? null
  : await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-term-profile'), {
      channel: 'msedge',
      headless: true,
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
    })
const browser = cdp ? await chromium.connectOverCDP(cdp) : null
const context = browser ? browser.contexts()[0] : disposableContext
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
  if (response.status() >= 500) errors.push('HTTP ' + response.status() + ' ' + response.url())
})

const clickIf = async (name) => {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  await page.waitForTimeout(400)
  return true
}

async function openMainInterface() {
  await page.waitForTimeout(1800)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1400)
  if (await clickIf('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIf('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIf('新建会话'))) await page.waitForTimeout(1400)
  }
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
}

async function selectWord(itemSelector, wanted) {
  return page.evaluate(
    ({ itemSelector, wanted }) => {
      const elements = [...document.querySelectorAll(itemSelector)]
      for (const element of elements) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const index = String(node.textContent || '').indexOf(wanted)
          if (index < 0) continue
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + wanted.length)
          const selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          const block = element.closest('[data-block-id]')
          block?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
          return {
            selected: true,
            blockId: block?.getAttribute('data-block-id') || '',
          }
        }
      }
      return { selected: false, blockId: '' }
    },
    { itemSelector, wanted },
  )
}

try {
  if (!cdp) await page.goto(url, { waitUntil: 'domcontentloaded' })
  await openMainInterface()
  await page.locator('.dpr-libraryItem', { hasText: 'Smart Sticker' }).first().click()
  await page.locator('.dpr-readerBarTitle').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('.dpr-readerText').first().waitFor({ state: 'visible', timeout: 20000 })

  const annotationBefore = await page.locator('.dpr-annotationItem').count()
  const singleSelected = await selectWord('.dpr-readerText', 'RFID')
  if (!singleSelected.selected) findings.push('单篇正文里没有选中 RFID')
  await page.locator('.dpr-selectionBar').waitFor({ state: 'visible', timeout: 8000 })
  const lookupButton = page.locator('.dpr-selectionBar').getByRole('button', { name: '查词', exact: true })
  await lookupButton.waitFor({ state: 'visible', timeout: 5000 })
  await lookupButton.click()
  await page.locator('.dpr-termCard').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-termCard .dpr-termMeaning').waitFor({ state: 'visible', timeout: 120000 })
  const singleText = (await page.locator('.dpr-termCard').innerText()).trim()
  if (!/RFID/.test(singleText)) findings.push('单篇查词卡没有 RFID')
  if (!/Radio Frequency Identification/i.test(singleText)) findings.push('单篇查词卡没有论文内缩写全称')
  if (/未能可靠确定/.test(singleText)) findings.push('单篇 RFID 没有得到语境解释')
  if (/生词本|收藏|掌握度|背诵/.test(singleText)) findings.push('查词卡混入了学习管理功能')
  const annotationAfter = await page.locator('.dpr-annotationItem').count()
  if (annotationAfter !== annotationBefore) findings.push('单篇查词错误地新增了批注')
  await mkdir(out, { recursive: true })
  await page.locator('.dpr-termCard').screenshot({ path: path.join(out, 'single-term-lookup.png') })
  await page.setViewportSize({ width: 560, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(500)
  const narrowBox = await page.locator('.dpr-termCard').boundingBox()
  if (!narrowBox || narrowBox.width > 544) findings.push('窄屏查词卡超出视口')
  if ((await page.locator('.dpr-termCard.is-narrow').count()) !== 1) {
    findings.push('窄屏查词卡没有进入响应式布局')
  }
  await page.screenshot({ path: path.join(out, 'single-term-lookup-dark-narrow.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(400)
  await page.locator('.dpr-termClose').click()

  const candidates = await page.evaluate(async () => {
    const library = await (await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })).json()
    const papers = Array.isArray(library.papers) ? library.papers : []
    const plague = papers.find((paper) => /Multiple Antimicrobial Resistance/.test(paper.title))
    const sticker = papers.find((paper) => /Smart Sticker/.test(paper.title))
    return plague && sticker ? [plague, sticker] : []
  })
  if (candidates.length < 2) findings.push('找不到双篇查词用的真实论文')
  else {
    await page.evaluate((papers) => {
      window.dispatchEvent(
        new CustomEvent('doraemon-paper-reader:compare', {
          detail: { mode: 'survey', jobIds: papers.map((paper) => paper.jobId) },
        }),
      )
    }, candidates)
    await page.locator('.dpr-cmpPaperPane').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('.dpr-cmpBlock').first().waitFor({ state: 'visible', timeout: 20000 })
    const compareSelected = await selectWord('.dpr-cmpPaperPane .dpr-cmpBlock', 'IncA/C')
    if (!compareSelected.selected) findings.push('双篇正文里没有选中 IncA/C')
    await page.locator('.dpr-cmpSelBar').waitFor({ state: 'visible', timeout: 8000 })
    await page.locator('.dpr-cmpSelBar').getByRole('button', { name: '查词', exact: true }).click()
    await page.locator('.dpr-termCard').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('.dpr-termCard .dpr-termMeaning').waitFor({ state: 'visible', timeout: 120000 })
    const compareText = (await page.locator('.dpr-termCard').innerText()).trim()
    if (!/IncA\/C/i.test(compareText)) findings.push('双篇查词卡没有 IncA/C')
    if (/未能可靠确定/.test(compareText)) findings.push('双篇 IncA/C 没有得到语境解释')
    if (!/p\.\d+/.test(compareText)) findings.push('双篇查词卡没有页码')
    await page.locator('.dpr-termCard').screenshot({ path: path.join(out, 'compare-term-lookup.png') })
    await page.locator('.dpr-termClose').click()
  }

  console.log(
    JSON.stringify(
      {
        single: singleText,
        compare: findings.length === 0 ? 'ok' : 'see findings',
        findings,
        errors,
        screenshots: [
          path.join(out, 'single-term-lookup.png'),
          path.join(out, 'single-term-lookup-dark-narrow.png'),
          path.join(out, 'compare-term-lookup.png'),
        ],
      },
      null,
      2,
    ),
  )
  if (findings.length || errors.length) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  else await context.close()
}
