#!/usr/bin/env node
// B7 真实 DSH：语义目录、滚动定位、研究/灵感模式与窄屏布局。

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
  else if (process.argv[index] === '--headed') args.headless = false
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const outDir = path.resolve(args.out ?? '工具/gen/B7-20261022/e2e')
const errors = []
await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-b7-outline-profile'),
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

async function clickIfVisible(name, timeout = 800) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click({ timeout })
  return true
}

async function openMainInterface() {
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
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
}

try {
  await page.addInitScript((jobId) => {
    try {
      window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
      window.localStorage.removeItem('doraemonPaperReader.readerMode.' + jobId)
      window.localStorage.removeItem('doraemonPaperReader.researchDirection')
    } catch {
      // ignore
    }
  }, args.job)
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await openMainInterface()
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({
    state: 'visible',
    timeout: 30000,
  })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const aside = page.locator('.dpr-readerOutline')
  await aside.waitFor({ state: 'visible', timeout: 15000 })

  const semanticReady = await aside
    .locator('h3')
    .filter({ hasText: /语义目录|原文目录/ })
    .waitFor({ state: 'visible', timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  if (!semanticReady) errors.push('60 秒内目录没有进入语义或回退完成状态')
  const groups = await aside.locator('.dpr-readerOutlineGroup').count()
  if (groups < 2) errors.push('语义目录分组不足：' + groups)
  const asideText = (await aside.innerText()).replace(/\s+/g, ' ')
  if (/Table\s*\d+|Figure\s*\d+|Algorithm\s*\d+|References/i.test(asideText)) {
    errors.push('目录污染了特殊块或参考文献：' + asideText.slice(0, 300))
  }

  const outlineItems = aside.locator('.dpr-readerOutlineItem')
  const itemCount = await outlineItems.count()
  if (itemCount < 3) errors.push('目录可点击条目不足：' + itemCount)
  if (itemCount > 0) {
    await outlineItems.last().click()
    await page.waitForTimeout(500)
    const activeCount = await aside.locator('.dpr-readerOutlineItem.is-active').count()
    if (activeCount !== 1) errors.push('目录滚动高亮不是唯一 active：' + activeCount)
    const scrollTop = await page.locator('.dpr-reader').evaluate((element) => element.scrollTop)
    if (scrollTop <= 0) errors.push('点击目录最后一项没有滚动正文')
  }

  const research = aside.getByRole('radio', { name: '研究模式', exact: true })
  await research.click()
  const editor = aside.locator('.dpr-researchEditor')
  await editor.waitFor({ state: 'visible', timeout: 5000 })
  await editor.locator('textarea').fill('轻量视觉模型在低功耗边缘设备上的准确率、时延和部署成本。')
  await editor.getByRole('button', { name: '保存并启用', exact: true }).click()
  if ((await research.getAttribute('aria-checked')) !== 'true') errors.push('研究模式没有启用')
  const storedDirection = await page.evaluate(() =>
    window.localStorage.getItem('doraemonPaperReader.researchDirection'),
  )
  if (!/低功耗边缘设备/.test(storedDirection || '')) errors.push('研究方向没有本地保存')

  const inspiration = aside.getByRole('radio', { name: '灵感模式', exact: true })
  await inspiration.click()
  if ((await inspiration.getAttribute('aria-checked')) !== 'true') errors.push('灵感模式没有启用')
  const hint = await aside.locator('.dpr-readerModeHint').innerText()
  if (!/未查新/.test(hint)) errors.push('灵感模式提示没有说明未查新降级')
  await page.screenshot({ path: path.join(outDir, 'outline-modes.png') })

  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(500)
  await page.locator('.dpr-reader').evaluate((element) => {
    element.scrollTop = 0
  })
  await page.waitForTimeout(300)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  )
  if (overflow) errors.push('375px 出现页面横向溢出')
  if ((await aside.getByRole('radio').count()) !== 3) errors.push('窄屏模式入口丢失')
  await page.screenshot({ path: path.join(outDir, 'outline-375.png') })
} catch (error) {
  errors.push(String(error))
  await page.screenshot({ path: path.join(outDir, 'failed.png') }).catch(() => {})
} finally {
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length > 0) process.exitCode = 1
