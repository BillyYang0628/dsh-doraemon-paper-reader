#!/usr/bin/env node
// L2：把同一篇论文的两个真实本地副本标成 VOR / 预印本，验证双栏与版本差异。
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
const url = args[args.indexOf('--url') + 1]
const out = path.resolve(args[args.indexOf('--out') + 1] || '工具/gen/version-diff-20261020')
if (!url) throw new Error('必须给 --url')
const jobsRoot = path.join(
  process.env.DSH_HOME || 'D:/DSH/home',
  'doraemon-paper-reader',
  'jobs',
)
const errors = []
const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-version-profile'), {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
page.on('pageerror', (error) => errors.push(String(error)))

const setVersion = async (jobId, kind) => {
  const result = await page.evaluate(
    async ({ jobId, kind }) => {
      const response = await fetch('doraemon-paper-reader/api/jobs/' + jobId + '/version', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || '设置版本失败：' + response.status)
      return payload.version
    },
    { jobId, kind },
  )
  return result
}

let leftJobId = ''
let rightJobId = ''
let leftSnapshot = null
let rightSnapshot = null

const snapshotJob = async (jobId) => {
  const dir = path.join(jobsRoot, jobId)
  return {
    doc: await readFile(path.join(dir, 'mirrordoc.json'), 'utf8'),
    summary: await readFile(path.join(dir, 'paper-summary.json'), 'utf8').catch(() => null),
  }
}

const restoreJob = async (jobId, snapshot) => {
  if (!jobId || !snapshot) return
  const dir = path.join(jobsRoot, jobId)
  await writeFile(path.join(dir, 'mirrordoc.json'), snapshot.doc, 'utf8')
  if (snapshot.summary !== null) {
    await writeFile(path.join(dir, 'paper-summary.json'), snapshot.summary, 'utf8')
  }
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1500)
  const clickIf = async (name) => {
    const target = page.getByRole('button', { name, exact: true }).first()
    if (!(await target.isVisible().catch(() => false))) return false
    await target.click()
    await page.waitForTimeout(450)
    return true
  }
  if (await clickIf('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIf('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIf('新建会话'))) await page.waitForTimeout(1500)
  }
  const libraryItem = page.locator('.dpr-libraryItem', { hasText: 'Multiple Antimicrobial Resistance' }).first()
  await libraryItem.waitFor({ state: 'visible', timeout: 20000 })
  const requestPromise = page.waitForRequest(
    (request) => /\/jobs\/[^/]+\/mirrordoc\.json/.test(request.url()),
    { timeout: 20000 },
  )
  await libraryItem.click()
  const request = await requestPromise
  leftJobId = request.url().match(/\/jobs\/([^/]+)\/mirrordoc\.json/)?.[1] || ''
  if (!leftJobId) throw new Error('没有从阅读页请求中拿到 jobId')
  await page.locator('.dpr-readerBarTitle').first().waitFor({ state: 'visible', timeout: 30000 })

  const target = await page.evaluate(
    async ({ leftJobId }) => {
      const versionsResponse = await fetch(
        'doraemon-paper-reader/api/jobs/' + leftJobId + '/versions',
        { cache: 'no-store' },
      )
      const versionsPayload = await versionsResponse.json().catch(() => ({}))
      if (!versionsResponse.ok) throw new Error(versionsPayload.error || '读取同篇版本失败')
      const other = (versionsPayload.versions || []).find((item) => item.jobId !== leftJobId)
      if (!other) throw new Error('找不到同篇论文的第二个本地副本')
      return {
        rightJobId: other.jobId,
        title: other.title,
      }
    },
    { leftJobId },
  )
  rightJobId = target.rightJobId
  leftSnapshot = await snapshotJob(leftJobId)
  rightSnapshot = await snapshotJob(rightJobId)

  await setVersion(leftJobId, 'vor')
  await setVersion(rightJobId, 'preprint')

  const versionButton = page.getByRole('button', { name: '版本对照', exact: true }).first()
  await versionButton.waitFor({ state: 'visible', timeout: 10000 })
  await versionButton.click()
  await page.locator('.dpr-cmpPaperPane').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-cmpPaperPane').nth(1).waitFor({ state: 'visible', timeout: 15000 })
  const badges = await page.locator('.dpr-cmpPaperVersion').allInnerTexts()
  if (!badges.some((text) => /VOR/.test(text))) errors.push('左侧没有 VOR 版本徽标')
  if (!badges.some((text) => /预印本/.test(text))) errors.push('右侧没有预印本徽标')

  await page.getByRole('button', { name: '版本差异', exact: true }).first().click()
  await page.locator('.dpr-cmpVersionGrid').waitFor({ state: 'visible', timeout: 60000 })
  const columns = await page.locator('.dpr-cmpVersionCol').count()
  if (columns !== 2) errors.push('版本差异不是两列：' + columns)
  const sideLabels = await page.locator('.dpr-cmpVersionSide strong').allInnerTexts()
  if (!sideLabels.some((text) => /正式版 VOR/.test(text))) errors.push('差异浮窗缺少 VOR 来源')
  if (!sideLabels.some((text) => /预印本/.test(text))) errors.push('差异浮窗缺少预印本来源')
  const added = await page.locator('.dpr-cmpVersionCol').first().locator('.dpr-cmpVersionItem').count()
  const removed = await page.locator('.dpr-cmpVersionCol').nth(1).locator('.dpr-cmpVersionItem').count()
  await mkdir(out, { recursive: true })
  await page.locator('.dpr-cmpArtWindow').screenshot({ path: path.join(out, 'version-diff.png') })
  console.log(
    JSON.stringify(
      {
        leftJobId,
        rightJobId,
        title: target.title,
        badges,
        sideLabels,
        columns,
        added,
        removed,
        errors,
      },
      null,
      2,
    ),
  )
  if (errors.length) process.exitCode = 1
} finally {
  try {
    await restoreJob(leftJobId, leftSnapshot)
    await restoreJob(rightJobId, rightSnapshot)
  } catch (error) {
    console.error('恢复版本状态失败：' + String(error))
  }
  await context.close()
}
