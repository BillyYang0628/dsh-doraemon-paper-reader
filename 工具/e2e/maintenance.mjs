#!/usr/bin/env node
// L2：主界面「环境与存储」统计、Python 状态与暗色展示。不执行缓存删除。
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
const url = args[args.indexOf('--url') + 1]
const out = path.resolve(args[args.indexOf('--out') + 1] || '工具/gen/maintenance-20261020')
const cdp = args.includes('--cdp') ? args[args.indexOf('--cdp') + 1] : ''
if (!url && !cdp) throw new Error('必须给 --url 或 --cdp')
const errors = []
const findings = []
const disposableContext = cdp
  ? null
  : await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-maintenance-profile'), {
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

const clickIf = async (name) => {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  await page.waitForTimeout(350)
  return true
}

try {
  if (!cdp) await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1400)
  if (await clickIf('打开右侧边栏')) await page.waitForTimeout(350)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIf('新标签页')) await page.waitForTimeout(550)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIf('新建会话'))) await page.waitForTimeout(1300)
  }
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('button', { name: '环境与存储', exact: true }).click()
  await page.locator('.dpr-maintenanceCard').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.dpr-maintenanceStat').first().waitFor({ state: 'visible', timeout: 15000 })
  const text = (await page.locator('.dpr-maintenanceCard').innerText()).trim()
  if (!/论文与正文/.test(text)) findings.push('维护页缺少论文统计')
  if (!/可重建缓存/.test(text)) findings.push('维护页缺少缓存统计')
  if (!/Python 运行时/.test(text)) findings.push('维护页缺少 Python 状态')
  if (!/受管环境已就绪/.test(text) && /待检查\/安装/.test(text)) {
    await page.getByRole('button', { name: '准备/修复 Python 环境', exact: true }).click()
    await page.getByText('受管环境已就绪', { exact: true }).waitFor({ state: 'visible', timeout: 120000 })
  }
  await mkdir(out, { recursive: true })
  await page.locator('.dpr-maintenanceCard').screenshot({ path: path.join(out, 'maintenance.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(350)
  await page.locator('.dpr-maintenanceCard').screenshot({ path: path.join(out, 'maintenance-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  console.log(
    JSON.stringify(
      {
        text,
        findings,
        errors,
        screenshots: [
          path.join(out, 'maintenance.png'),
          path.join(out, 'maintenance-dark.png'),
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
