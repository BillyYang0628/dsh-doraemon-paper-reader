#!/usr/bin/env node
// L2：信息查询多路候选的主候选、匹配分、置信度与理由。

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
let url = ''
let outDir = '工具/gen/lookup-candidates-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--url') url = args[++index]
  else if (args[index] === '--out') outDir = args[++index]
}
if (!url) throw new Error('必须给 --url')

const errors = []
const context = await chromium.launchPersistentContext('工具/gen/_e2e-lookup-candidates-profile', {
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
  await page.locator('.dpr-pane .dpr-card').nth(1).click()
  await page.locator('.dpr-lookup').waitFor({ state: 'visible', timeout: 15000 })
  await page.getByPlaceholder('论文标题（可只填关键词）').fill('Smart Sticker')
  await page.getByPlaceholder('作者 / 团队').fill('Matic')
  await page.getByPlaceholder('Sensors / NeurIPS / …').fill('Sensors')
  await page.getByPlaceholder('2022').fill('2022')
  await page.getByRole('button', { name: '去找论文', exact: true }).click()
  await page.locator('.dpr-candidate').first().waitFor({ state: 'visible', timeout: 30000 })
  const primary = page.locator('.dpr-candidate.is-primary')
  if ((await primary.count()) !== 1) errors.push('查询候选没有唯一主候选')
  const primaryText = (await primary.first().innerText()).replace(/\s+/g, ' ')
  if (!/最可能匹配/.test(primaryText)) errors.push('主候选没有文字标签')
  if (!/匹配分 \d+\/100/.test(primaryText)) errors.push('主候选没有匹配分')
  if (!/[高中低]置信/.test(primaryText)) errors.push('主候选没有置信度')
  if (!/标题|作者|年份|刊物|参考文献/.test(primaryText)) errors.push('主候选没有排序依据')
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'lookup-candidates.png') })
  console.log(
    JSON.stringify(
      {
        out: outDir,
        candidates: await page.locator('.dpr-candidate').count(),
        primaryText,
        errors,
      },
      null,
      2,
    ),
  )
  if (errors.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
