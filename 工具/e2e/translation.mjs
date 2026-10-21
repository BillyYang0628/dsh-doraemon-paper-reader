#!/usr/bin/env node
// L2：阅读页语言切换（原文 → 中文 → 对照 → 中文 → 原文）。
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/translation.mjs --url "http://127.0.0.1:3116/?token=…" --title "Sharing Detailed"

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

const args = { headless: true }
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--url') args.url = process.argv[++i]
  else if (process.argv[i] === '--title') args.title = process.argv[++i]
  else if (process.argv[i] === '--job') args.job = process.argv[++i]
  else if (process.argv[i] === '--out') args.out = process.argv[++i]
  else if (process.argv[i] === '--review') args.review = true
  else if (process.argv[i] === '--table-block') args.tableBlock = process.argv[++i]
  else if (process.argv[i] === '--headed') args.headless = false
}
if (!args.url) throw new Error('必须给 --url')
const outDir = path.resolve(args.out ?? '工具/gen/translation-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const errors = []
const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-translation-profile'), {
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
  const button = page.getByRole('button', { name, exact: true }).first()
  if (!(await button.isVisible().catch(() => false))) return false
  await button.click()
  await page.waitForTimeout(400)
  return true
}

try {
  await page.addInitScript((jobId) => {
    try {
      if (jobId) window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
      else window.localStorage.removeItem('doraemonPaperReader.lastJobId')
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index)
        if (key && key.startsWith('doraemonPaperReader.langMode.')) window.localStorage.removeItem(key)
      }
    } catch {
      // ignore
    }
  }, args.job || '')
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1500)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(500)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1500)
  }
  if (args.job) {
    await page.locator('.dpr-pane .dpr-card').first().click()
    await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  } else {
    await page.locator('.dpr-libraryItem').first().waitFor({ state: 'visible', timeout: 20000 })
    const item = args.title
      ? page.locator('.dpr-libraryItem', { hasText: args.title }).first()
      : page.locator('.dpr-libraryItem').first()
    await item.click()
  }
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(600)
  await mkdir(outDir, { recursive: true })

  const lang = page.locator('.dpr-langSwitch[aria-label]').first()
  if ((await lang.innerText()).trim() !== '原文') errors.push('初始语言不是原文')
  await lang.click()
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(1000)
    if ((await lang.innerText()).trim() === '中文') break
  }
  const zhTitle = (await page.locator('.dpr-readerTitle').innerText()).trim()
  if (zhTitle === 'Sharing Detailed Research Data Is Associated with Increased Citation Rate') {
    errors.push('中文模式标题没有翻译')
  }
  const zhLinks = await page.locator('.dpr-citeLink').count()
  if (zhLinks === 0) errors.push('中文模式没有复用引用蓝链')
  await page.screenshot({ path: path.join(outDir, 'translation-zh.png') })

  await lang.click()
  await page.waitForTimeout(700)
  const pairs = await page.locator('.dpr-biPair').count()
  const sources = await page.locator('.dpr-biSource').count()
  const targets = await page.locator('.dpr-biTarget').count()
  if ((await lang.innerText()).trim() !== '对照') errors.push('第二次点击没有进入对照模式')
  if (pairs < 10 || sources < 10 || targets < 10) {
    errors.push('对照模式没有按小段交替：' + JSON.stringify({ pairs, sources, targets }))
  }
  const bilingualLinks = await page.locator('.dpr-citeLink').count()
  if (bilingualLinks < zhLinks) errors.push('对照模式引用蓝链少于中文模式')
  await page.screenshot({ path: path.join(outDir, 'translation-bilingual.png') })

  const equation = page.locator('.dpr-readerFigure[data-kind="equation"]').first()
  if ((await equation.count()) > 0) {
    await equation.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const equationState = await equation.evaluate((element) => ({
      text: element.textContent || '',
      image: element.querySelector('img')?.naturalWidth || 0,
    }))
    if (equationState.image === 0) errors.push('公式原图没有加载')
    if (equationState.text.includes('(cid:')) errors.push('公式伪字形仍显示在阅读页')
    const latex = await equation.locator('.dpr-latexCode').innerText().catch(() => '')
    if (!latex.includes('\\')) errors.push('公式 LaTeX 没有显示或为空')
    await page.screenshot({ path: path.join(outDir, 'translation-equation.png') })
  }

  const figure = page.locator('.dpr-readerFigure[data-kind="figure"]').first()
  if ((await figure.count()) > 0) {
    await figure.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(outDir, 'translation-figure.png') })
  }

  const translatedTable = page.locator('.dpr-tableTrans').first()
  if ((await translatedTable.count()) > 0) {
    const rows = await translatedTable.locator('tr').count()
    if (rows < 2) errors.push('表格译文没有有效行')
    await translatedTable.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(outDir, 'translation-table.png') })
  } else {
    errors.push('对照模式没有渲染表格单元格译文')
  }
  if (args.tableBlock) {
    const structuredTable = page
      .locator('[data-block-id="' + args.tableBlock + '"] .dpr-tableTrans')
      .first()
    if ((await structuredTable.count()) === 0) {
      errors.push('指定表格没有结构化译文：' + args.tableBlock)
    } else {
      await structuredTable.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      const columns = await structuredTable.locator('tr').first().locator('th,td').count()
      if (columns < 20) errors.push('指定表格列数不足：' + columns)
      await page.screenshot({ path: path.join(outDir, 'translation-table-block.png') })
    }
  }
  const tableFallback = page.getByText('表格单元格译文未通过校验，仅保留原表。', { exact: true }).first()
  if ((await tableFallback.count()) > 0) {
    await tableFallback.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(outDir, 'translation-table-fallback.png') })
  }

  if (args.review) {
    const reviewButton = page.getByRole('button', { name: /^复核/ }).first()
    if ((await reviewButton.count()) === 0) errors.push('没有找到译文复核按钮')
    else {
      await reviewButton.click()
      await page.waitForTimeout(700)
      let panelVisible = await page.locator('.dpr-reviewIssue').first().isVisible().catch(() => false)
      const reviewed = panelVisible || await page
        .getByText(/译文复核：/)
        .first()
        .waitFor({ state: 'visible', timeout: 180000 })
        .then(() => true)
        .catch(() => false)
      if (!reviewed) errors.push('等待 180 秒仍未看到译文复核完成')
      if ((await page.getByText(/译文复核没有完成/).count()) > 0) errors.push('译文复核界面显示失败')
      await page.screenshot({ path: path.join(outDir, 'translation-review.png') })
      if (reviewed) {
        panelVisible = await page.locator('.dpr-reviewIssue').first().isVisible().catch(() => false)
        if (panelVisible) {
          // 复核按钮直接打开了问题面板。
        } else {
          const viewIssues = page.getByRole('button', { name: /查看(问题|记录)/ }).first()
          if ((await viewIssues.count()) > 0) {
            await viewIssues.click()
            await page.locator('.dpr-reviewIssue').first().waitFor({ state: 'visible', timeout: 5000 })
          } else {
            errors.push('复核完成后没有「查看问题」入口')
          }
        }
        if ((await page.locator('.dpr-reviewIssue').count()) > 0) {
          const issueCount = await page.locator('.dpr-reviewIssue').count()
          if (issueCount === 0) errors.push('复核问题面板没有条目')
          const acceptButton = page.getByRole('button', { name: '采用修订', exact: true }).first()
          if ((await acceptButton.count()) > 0) {
            await acceptButton.click()
            await page.getByText('已采用', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
              errors.push('采用修订后没有显示「已采用」')
            })
          }
          await page.screenshot({ path: path.join(outDir, 'translation-review-issues.png') })
          await page.locator('.dpr-reviewHead').first().click()
          await page.waitForTimeout(500)
          if ((await page.locator('.dpr-flash').count()) === 0) errors.push('点击复核问题没有定位原段')
        } else {
          errors.push('复核问题面板没有条目')
        }
      }
    }
  }

  await lang.click()
  await page.waitForTimeout(250)
  if ((await lang.innerText()).trim() !== '原文') errors.push('对照后没有回到原文')

  console.log(JSON.stringify({ out: outDir, zhTitle, zhLinks, pairs, sources, targets, bilingualLinks, errors }, null, 2))
  if (errors.length) process.exitCode = 1
} finally {
  await context.close()
}
