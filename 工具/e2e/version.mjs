#!/usr/bin/env node
// L2：阅读页手动版本核验可保存、刷新后保留，并在测试后恢复原值。

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

const args = { headless: true }
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--url') args.url = process.argv[++i]
  else if (process.argv[i] === '--job') args.job = process.argv[++i]
  else if (process.argv[i] === '--out') args.out = process.argv[++i]
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const outDir = path.resolve(args.out ?? '工具/gen/version-20261020')
const errors = []
await mkdir(outDir, { recursive: true })
const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-version-profile'), {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())
let originalKind = 'unknown'

async function clickIfVisible(name) {
  const button = page.getByRole('button', { name, exact: true }).first()
  if (!(await button.isVisible().catch(() => false))) return false
  await button.click()
  await page.waitForTimeout(400)
  return true
}

async function openMainInterface() {
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1400)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(500)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1400)
  }
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
}

try {
  await page.addInitScript((jobId) => {
    try {
      window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
    } catch {
      // ignore
    }
  }, args.job)
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await openMainInterface()
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const select = page.locator('.dpr-versionSelect')
  await select.waitFor({ state: 'visible', timeout: 10000 })
  originalKind = await select.inputValue()
  await select.selectOption('vor')
  await page.waitForTimeout(500)
  if ((await select.inputValue()) !== 'vor') errors.push('选择 VOR 后控件没有更新')
  const backend = await page.evaluate(async (jobId) => {
    const response = await fetch('/doraemon-paper-reader/api/jobs/' + jobId + '/mirrordoc.json', {
      cache: 'no-store',
    })
    return response.json()
  }, args.job)
  if (backend?.version?.kind !== 'vor') errors.push('VOR 没有写入 MirrorDoc')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  if ((await page.locator('.dpr-readerTitle').count()) === 0) {
    await openMainInterface()
    await page.locator('.dpr-pane .dpr-card').first().click()
    await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
    await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 20000 })
  }
  await page.locator('.dpr-versionSelect').waitFor({ state: 'visible', timeout: 10000 })
  if ((await page.locator('.dpr-versionSelect').inputValue()) !== 'vor') {
    errors.push('刷新后版本选择没有保留')
  }
  await page.screenshot({ path: path.join(outDir, 'version-vor.png') })
} finally {
  if (originalKind) {
    await page
      .evaluate(
        async ({ jobId, kind }) => {
          await fetch('/doraemon-paper-reader/api/jobs/' + jobId + '/version', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
          })
        },
        { jobId: args.job, kind: originalKind },
      )
      .catch(() => {})
  }
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length) process.exitCode = 1
