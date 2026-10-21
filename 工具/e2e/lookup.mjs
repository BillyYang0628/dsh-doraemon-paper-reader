#!/usr/bin/env node
// B 信息查询 L2：多字段表单 → 严格正式版元数据卡 → 标题候选 → arXiv HTML 取回 → 阅读页。

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
let url = ''
let outDir = '工具/gen/lookup-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') url = args[++i]
  else if (args[i] === '--out') outDir = args[++i]
}
if (!url) throw new Error('必须给 --url')

const errors = []
const context = await chromium.launchPersistentContext('工具/gen/_e2e-lookup-profile', {
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
  await page.locator('.dpr-pane .dpr-card').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-pane .dpr-card').nth(1).click()
  await page.locator('.dpr-lookup').waitFor({ state: 'visible', timeout: 15000 })
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'lookup-form.png') })

  const inputCount = await page.locator('.dpr-lookupField input').count()
  if (inputCount < 6) errors.push('查询表单字段不足：' + inputCount)
  const modes = page.locator('.dpr-lookupMode button')
  if ((await modes.count()) !== 2) errors.push('正式版/OA 版选择数量不对')

  // 1) 严格正式版：只出元数据卡与官方链接
  await modes.nth(1).click()
  await page.getByPlaceholder('10.3390/s22114003').fill('10.3390/s22114003')
  await page.getByRole('button', { name: '去找论文', exact: true }).click()
  await page.locator('.dpr-metaCard').waitFor({ state: 'visible', timeout: 30000 })
  const strictText = (await page.locator('.dpr-metaCard').innerText()).replace(/\s+/g, ' ')
  if (!strictText.includes('官方页面') && !strictText.includes('Smart Sticker')) {
    errors.push('严格正式版没有给出元数据/官方链接：' + strictText.slice(0, 200))
  }
  if ((await page.getByRole('link', { name: '打开官方页面', exact: true }).count()) === 0) {
    errors.push('严格正式版没有官方页面链接')
  }
  await page.screenshot({ path: path.join(outDir, 'lookup-strict.png') })

  // 2) 多字段标题搜索：标题 + 作者 + 刊物 + 年份
  await modes.nth(0).click()
  await page.getByPlaceholder('10.3390/s22114003').fill('')
  await page.getByPlaceholder('论文标题（可只填关键词）').fill('Smart Sticker')
  await page.getByPlaceholder('作者 / 团队').fill('Matic')
  await page.getByPlaceholder('Sensors / NeurIPS / …').fill('Sensors')
  await page.getByPlaceholder('2022').fill('2022')
  await page.getByRole('button', { name: '去找论文', exact: true }).click()
  await page.locator('.dpr-candidate').first().waitFor({ state: 'visible', timeout: 30000 })
  if ((await page.locator('.dpr-candidate').count()) === 0) errors.push('多字段查询没有候选结果')
  await page.screenshot({ path: path.join(outDir, 'lookup-candidates.png') })

  // 3) arXiv HTML：精确查询 → 取回 → 阅读页
  await page.getByPlaceholder('论文标题（可只填关键词）').fill('')
  await page.getByPlaceholder('作者 / 团队').fill('')
  await page.getByPlaceholder('Sensors / NeurIPS / …').fill('')
  await page.getByPlaceholder('2022').fill('')
  await page.getByPlaceholder('2501.12948').fill('2502.00306v2')
  await page.getByRole('button', { name: '去找论文', exact: true }).click()
  await page.locator('.dpr-metaCard').waitFor({ state: 'visible', timeout: 30000 })
  const exactText = (await page.locator('.dpr-metaCard').innerText()).replace(/\s+/g, ' ')
  if (!exactText.includes('Riddle Me This')) errors.push('arXiv 精确查询标题不对：' + exactText.slice(0, 200))
  await page.getByRole('button', { name: '取回并阅读', exact: true }).click()
  await page.locator('.dpr-load').waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({ state: 'visible', timeout: 180000 })
  await page.screenshot({ path: path.join(outDir, 'lookup-done.png') })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const readerTitle = (await page.locator('.dpr-readerTitle').innerText()).trim()
  if (!readerTitle.includes('Riddle Me This')) errors.push('arXiv 阅读页标题不对：' + readerTitle)
  const figureCount = await page.locator('.dpr-readerFigure img').count()
  if (figureCount < 1) errors.push('arXiv HTML 阅读页没有图片')
  await page.screenshot({ path: path.join(outDir, 'lookup-reader.png') })

  console.log(JSON.stringify({ errors, readerTitle, figureCount, inputCount }, null, 2))
  if (errors.length > 0) process.exitCode = 1
} catch (error) {
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'lookup-failed.png') }).catch(() => {})
  console.log('failure body', (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 2500))
  console.log('failure console', JSON.stringify(errors))
  throw error
} finally {
  await context.close()
}
