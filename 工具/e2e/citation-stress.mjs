#!/usr/bin/env node
// B5/B7 蓝链压力回归：真实 DSH 阅读页逐条点击去重引用，记录 HTTP 状态与业务 kind。

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = { headless: true, max: 12, scope: 'unique' }
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--url') args.url = process.argv[++index]
  else if (process.argv[index] === '--job') args.job = process.argv[++index]
  else if (process.argv[index] === '--out') args.out = process.argv[++index]
  else if (process.argv[index] === '--max') args.max = Number(process.argv[++index])
  else if (process.argv[index] === '--scope') args.scope = process.argv[++index]
  else if (process.argv[index] === '--headed') args.headless = false
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')
if (!['unique', 'all'].includes(args.scope)) {
  throw new Error('--scope 只接受 unique 或 all')
}

const outDir = path.resolve(args.out ?? '工具/gen/citation-stress')
const errors = []
const results = []
const citationHttpErrors = []
await mkdir(outDir, { recursive: true })
const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-citation-stress-profile'),
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
page.on('response', (response) => {
  if (
    response.url().includes('/doraemon-paper-reader/api/citations/') &&
    response.status() >= 400
  ) {
    citationHttpErrors.push({
      status: response.status(),
      url: response.url(),
    })
  }
})

async function clickIfVisible(name, timeout = 800) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click({ timeout })
  return true
}

async function openReader() {
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
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({
    state: 'visible',
    timeout: 30000,
  })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
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
  await openReader()

  const links = page.locator('.dpr-citeLink')
  await links.first().waitFor({ state: 'visible', timeout: 30000 })
  const all = await links.count()
  if (all === 0) errors.push('阅读页没有引用蓝链')
  const labels = await links.allInnerTexts()
  const occurrences = labels
    .map((label, index) => ({ label: label.trim(), index }))
    .filter((item) => item.label)
  const uniqueLabels = [...new Set(occurrences.map((item) => item.label))]
  const targets =
    args.scope === 'all'
      ? occurrences.slice(0, args.max)
      : uniqueLabels.map((label) => ({ label, index: -1 })).slice(0, args.max)
  let followedExisting = 0
  let followedCandidates = 0
  for (const target of targets) {
    const label = target.label
    const link =
      target.index >= 0
        ? links.nth(target.index)
        : links.filter({ hasText: label }).first()
    if ((await link.count()) === 0) continue
    let response
    try {
      if (/[,\-–]/.test(label)) {
        await link.click()
        const choice = page.locator('.dpr-citeChoices button').first()
        await choice.waitFor({ state: 'visible', timeout: 10000 })
        const wait = page.waitForResponse(
          (item) =>
            item.url().includes('/doraemon-paper-reader/api/citations/resolve') &&
            item.request().method() === 'POST',
          { timeout: 30000 },
        )
        await choice.click()
        response = await wait
      } else {
      const wait = page.waitForResponse(
        (item) =>
          item.url().includes('/doraemon-paper-reader/api/citations/resolve') &&
          item.request().method() === 'POST',
        { timeout: 30000 },
      )
      await link.click()
      response = await wait
      }
      const body = await response.json().catch(() => ({}))
      results.push({
        occurrence: target.index,
        label,
        status: response.status(),
        kind: body.kind || '',
        message: body.message || body.error || '',
        number: body.number || 0,
      })
      if (body.kind === 'candidates' && followedCandidates < 2) {
        const candidate = page.locator('.dpr-candidate').first()
        await candidate.waitFor({ state: 'visible', timeout: 15000 })
        followedCandidates += 1
        const candidateWait = page.waitForResponse(
          (item) =>
            item.url().includes('/doraemon-paper-reader/api/citations/resolve') &&
            item.request().method() === 'POST',
          { timeout: 30000 },
        )
        await candidate.click()
        const candidateResponse = await candidateWait
        const candidateBody = await candidateResponse.json().catch(() => ({}))
        results[results.length - 1].candidate = {
          status: candidateResponse.status(),
          kind: candidateBody.kind || '',
          number: candidateBody.number || 0,
          message: candidateBody.message || candidateBody.error || '',
        }
      }
      if (body.kind === 'existing' && followedExisting < 2) {
        followedExisting += 1
        const settled = await page
          .waitForFunction(
            () => {
              const card = document.querySelector('.dpr-citeCard')
              if (!card) return false
              return Boolean(
                card.querySelector('.dpr-citeSection') ||
                card.querySelector('.dpr-citeWarn') ||
                card.querySelector('.dpr-error'),
              )
            },
            null,
            { timeout: 120000 },
          )
          .then(() => true)
          .catch(() => false)
        results[results.length - 1].followedToReady = settled
        if (!settled) errors.push('现有引用 ' + label + ' 120 秒内没有完成分析')
      }
    } catch (error) {
      results.push({
        occurrence: target.index,
        label,
        status: 0,
        kind: 'timeout',
        message: String(error),
      })
    }
    await page.waitForTimeout(150)
    const close = page.locator('.dpr-citeClose').last()
    if (await close.isVisible().catch(() => false)) await close.click()
    await page.waitForTimeout(120)
  }

  const bad = results.filter(
    (item) =>
      item.status >= 400 ||
      item.status === 0 ||
      Number(item.candidate?.status || 0) >= 400,
  )
  if (bad.length > 0) errors.push('引用请求失败：' + JSON.stringify(bad))
  if (citationHttpErrors.length > 0) {
    errors.push('引用 API 出现 HTTP 错误：' + JSON.stringify(citationHttpErrors))
  }
  await page.screenshot({ path: path.join(outDir, 'citation-stress.png') })
  await writeFile(
    path.join(outDir, 'result.json'),
    JSON.stringify(
      {
        linkCount: all,
        scope: args.scope,
        uniqueCount: uniqueLabels.length,
        uniqueTested: [...new Set(results.map((item) => item.label))],
        results,
        citationHttpErrors,
        errors,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(JSON.stringify({ out: outDir, linkCount: all, tested: results.length, bad, errors }, null, 2))
  if (errors.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
