#!/usr/bin/env node
// 表格/Supporting Information 二次排版验收：打开 PLOS 论文，检查三个表格裁剪图与分块。

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
let url = ''
let outDir = '工具/gen/layout-fix-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') url = args[++i]
  else if (args[i] === '--out') outDir = args[++i]
}
if (!url) throw new Error('必须给 --url')

const errors = []
const context = await chromium.launchPersistentContext('工具/gen/_e2e-layout-profile', {
  channel: 'msedge',
  headless: true,
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
  if (await target.isVisible().catch(() => false)) {
    await target.click()
    return true
  }
  return false
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(500)
  await clickIfVisible('新标签页')
  await page.waitForTimeout(500)
  const entry = page.getByRole('button', { name: '论文阅读器' }).last()
  if (await entry.isVisible().catch(() => false)) await entry.click()
  const libraryItem = page.locator('.dpr-libraryItem').filter({ hasText: 'Sharing Detailed Research Data' }).first()
  await libraryItem.waitFor({ state: 'visible', timeout: 15000 })
  await libraryItem.click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  await mkdir(outDir, { recursive: true })

  const tables = page.locator('.dpr-readerFigure[data-kind="table"]')
  if ((await tables.count()) !== 3) errors.push('表格块不是 3 个：' + (await tables.count()))
  const loaded = await page.evaluate(() =>
    [...document.querySelectorAll('.dpr-readerFigure[data-kind="table"] img')].map((image) => ({
      complete: image.complete,
      width: image.naturalWidth,
    })),
  )
  if (loaded.some((image) => !image.complete || image.width === 0)) {
    errors.push('有表格裁剪图没有加载：' + JSON.stringify(loaded))
  }
  await tables.first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(outDir, 'table1.png') })

  const supporting = page.getByText('SUPPORTING INFORMATION', { exact: true }).first()
  await supporting.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const supportingText = await page.locator('.dpr-readerBody').innerText()
  for (const label of ['SUPPORTING INFORMATION', 'Text S1', 'Text S2', 'Text S3']) {
    if (!supportingText.includes(label)) errors.push('缺少 Supporting 分块：' + label)
  }
  await page.screenshot({ path: path.join(outDir, 'supporting.png') })

  const page3Paragraph = page.locator('p.dpr-readerP').filter({ hasText: 'We note an important limitation' }).first()
  if ((await page3Paragraph.count()) > 0) {
    await page3Paragraph.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const style = await page3Paragraph.evaluate((element) => ({
      indent: getComputedStyle(element).textIndent,
      align: getComputedStyle(element).textAlign,
    }))
    if (parseFloat(style.indent) > 30) errors.push('双栏右栏段落缩进过大：' + JSON.stringify(style))
    if (style.align === 'justify') errors.push('正文仍然是 justify，短行会被拉成大空格')
    await page.screenshot({ path: path.join(outDir, 'page3.png') })
  } else {
    errors.push('没有找到 page 3 的 “We note an important limitation” 段落')
  }

  console.log(JSON.stringify({ errors, tables: loaded.length }, null, 2))
  if (errors.length > 0) process.exitCode = 1
} catch (error) {
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'failed.png') }).catch(() => {})
  console.log('failure', (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 2000))
  throw error
} finally {
  await context.close()
}
