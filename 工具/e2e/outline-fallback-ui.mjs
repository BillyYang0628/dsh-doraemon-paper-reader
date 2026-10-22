#!/usr/bin/env node
// 确定性失败态 UI：语义目录 404 回退样式与研究模式首次启用说明。

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = { headless: true }
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--url') args.url = process.argv[++index]
  else if (process.argv[index] === '--job') args.job = process.argv[++index]
  else if (process.argv[index] === '--out') args.out = process.argv[++index]
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const outDir = path.resolve(args.out ?? '工具/gen/B7-20261022/e2e/outline-fallback')
const errors = []
await mkdir(outDir, { recursive: true })
const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-b7-fallback-profile'),
  { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' },
)
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    !/status of 404 \(Not Found\)/i.test(message.text())
  ) {
    errors.push(message.text())
  }
})
page.on('pageerror', (error) => errors.push(String(error)))

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  return true
}

try {
  await page.route('**/doraemon-paper-reader/api/jobs/*/semantic-outline', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Not found' }),
    })
  })
  await page.addInitScript((jobId) => {
    try {
      window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
      window.localStorage.removeItem('doraemonPaperReader.researchDirection')
    } catch {
      // ignore
    }
  }, args.job)
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1400)
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
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({
    state: 'visible',
    timeout: 30000,
  })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })

  const fallback = page.locator('.dpr-outlineFallback')
  await fallback.waitFor({ state: 'visible', timeout: 15000 })
  const fallbackText = (await fallback.innerText()).replace(/\s+/g, ' ')
  if (/Not found|HTTP 404/i.test(fallbackText)) errors.push('回退提示仍暴露英文 Not found')
  if (!/原始章节/.test(fallbackText)) errors.push('回退提示没有说明当前显示原始章节')
  const retry = fallback.locator('.dpr-outlineRetry')
  if ((await retry.count()) !== 1) errors.push('回退区没有独立重试样式')
  if ((await retry.innerText()).trim() !== '重试概括') errors.push('回退按钮文案不对')

  const research = page.getByRole('radio', { name: '研究模式', exact: true })
  await research.click()
  const help = page.locator('.dpr-researchHelp')
  await help.waitFor({ state: 'visible', timeout: 5000 })
  const helpText = (await help.innerText()).replace(/\s+/g, ' ')
  if (!/仍先解释论文本身/.test(helpText) || !/回答末尾/.test(helpText)) {
    errors.push('研究模式首次启用说明不完整：' + helpText)
  }
  if (!/只保存在本机|不会启用/.test(helpText)) errors.push('研究模式说明缺少隐私/启用边界')
  await page.screenshot({ path: path.join(outDir, 'outline-fallback-research-help.png') })
} catch (error) {
  errors.push(String(error))
  await page.screenshot({ path: path.join(outDir, 'failed.png') }).catch(() => {})
} finally {
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length > 0) process.exitCode = 1
