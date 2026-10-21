#!/usr/bin/env node
// L2：低置信度公式只在警示区出现，手动修正后保存并可再次读取。

import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

const args = { headless: true }
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--url') args.url = process.argv[++i]
  else if (process.argv[i] === '--job') args.job = process.argv[++i]
  else if (process.argv[i] === '--job-dir') args.jobDir = process.argv[++i]
  else if (process.argv[i] === '--out') args.out = process.argv[++i]
}
if (!args.url || !args.job || !args.jobDir) throw new Error('必须给 --url、--job、--job-dir')

const outDir = path.resolve(args.out ?? '工具/gen/formula-correction-20261020')
const formulaFile = path.join(path.resolve(args.jobDir), 'formulas.json')
const original = await readFile(formulaFile, 'utf8')
const errors = []
await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-formula-profile'), {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())

async function clickIfVisible(name) {
  const button = page.getByRole('button', { name, exact: true }).first()
  if (!(await button.isVisible().catch(() => false))) return false
  await button.click()
  await page.waitForTimeout(400)
  return true
}

try {
  const payload = JSON.parse(original)
  const targetId = Object.keys(payload.blocks || {}).sort()[0]
  if (!targetId) throw new Error('formulas.json 没有公式')
  payload.blocks[targetId] = {
    ...payload.blocks[targetId],
    latex: 'x=\\frac{1}{',
    confidence: 0.2,
    warnings: ['manual-e2e-low-confidence'],
    valid: false,
  }
  await writeFile(formulaFile, JSON.stringify(payload, null, 2), 'utf8')

  await page.addInitScript((jobId) => {
    try {
      window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
    } catch {
      // ignore
    }
  }, args.job)
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1400)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  if (await clickIfVisible('新标签页')) await page.waitForTimeout(500)
  const entry = page.getByRole('button', { name: '论文阅读器' }).last()
  if (await entry.isVisible().catch(() => false)) await entry.click()
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const input = page.locator('.dpr-latexInput').first()
  await input.waitFor({ state: 'visible', timeout: 15000 })
  await input.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, 'formula-low-confidence.png') })
  await input.fill('M(t)=x(t)')
  await page.getByRole('button', { name: '保存修正', exact: true }).first().click()
  await page.getByText('公式 LaTeX 已保存。', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 })
  if ((await page.locator('.dpr-latexCode').count()) === 0) errors.push('保存后没有切回有效 LaTeX 视图')
  const backend = await page.evaluate(async (jobId) => {
    const response = await fetch('/doraemon-paper-reader/api/jobs/' + jobId + '/formulas', { cache: 'no-store' })
    return response.json()
  }, args.job)
  const saved = backend.blocks?.[targetId]
  if (!saved?.valid || !saved?.manual) errors.push('手动修正没有写入 formulas.json')
  await page.screenshot({ path: path.join(outDir, 'formula-corrected.png') })
} finally {
  await writeFile(formulaFile, original, 'utf8')
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length) process.exitCode = 1
