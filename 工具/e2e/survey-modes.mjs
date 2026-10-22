#!/usr/bin/env node
// B9：真实 DSH 中跑 2 篇方法对照、不可比负例、3 篇研究缺口与证据报告。

import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { cdp: 'http://127.0.0.1:9222' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') out.url = argv[++index]
    else if (arg === '--cdp') out.cdp = argv[++index]
    else if (arg === '--task-report') out.taskReport = argv[++index]
    else if (arg === '--out') out.out = argv[++index]
    else if (arg === '--profile') out.profile = argv[++index]
    else throw new Error('未知参数：' + arg)
  }
  if (!out.taskReport) throw new Error('必须给 --task-report')
  return out
}

const args = parseArgs(process.argv.slice(2))
const tasks = JSON.parse(await readFile(path.resolve(args.taskReport), 'utf8')).tasks
const outDir = path.resolve(args.out ?? '工具/gen/B9-20261022/e2e/survey-modes')
const errors = []
const screenshots = []
const evidence = {}
await mkdir(outDir, { recursive: true })

let browser
let page
if (args.url) {
  browser = await chromium.launchPersistentContext(
    path.resolve(args.profile ?? '工具/gen/_b9-survey-profile'),
    {
      channel: 'msedge',
      headless: true,
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      acceptDownloads: true,
    },
  )
  page = browser.pages()[0] ?? (await browser.newPage())
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
} else {
  browser = await chromium.connectOverCDP(args.cdp)
  page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith('dsh-app://'))
}
if (!page) throw new Error('未找到 DSH 页面')

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

async function openHome() {
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1300)
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
  await page.locator('.dpr-homePane').waitFor({ state: 'visible', timeout: 30000 })
}

async function visibleTaskJobs(task) {
  const library = await page.evaluate(async () => {
    const response = await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || response.statusText)
    return payload
  })
  const papers = Array.isArray(library.papers) ? library.papers : []
  const resolved = []
  for (const title of task.titles) {
    const exact = papers.find((paper) => paper.title === title)
    if (!exact) throw new Error('综述候选在默认论文库中不可见：' + title)
    if (!resolved.includes(exact.jobId)) resolved.push(exact.jobId)
  }
  return resolved
}

async function openSurvey(task, modeLabel, { direct = false } = {}) {
  if (direct) {
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('doraemon-paper-reader:compare', { detail }))
    }, {
      mode: 'survey',
      surveyMode: modeLabel.includes('研究缺口')
        ? 'gap'
        : modeLabel.includes('综述报告')
          ? 'report'
          : 'method',
      jobIds: task.jobIds,
    })
    await page.locator('.dpr-comparePanel').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.dpr-cmpSurveyBrief').waitFor({ state: 'visible', timeout: 30000 })
    return task.jobIds
  }
  const jobIds = await visibleTaskJobs(task)
  await openHome()
  await page.locator('.dpr-surveyCard').click()
  await page.locator('.dpr-surveyModes').waitFor({ state: 'visible', timeout: 20000 })
  for (const jobId of jobIds) {
    const input = page.locator('.dpr-surveyRow[data-job-id="' + jobId + '"] input[type=checkbox]')
    await input.check()
  }
  const mode = page.locator('.dpr-surveyMode').filter({ hasText: modeLabel }).first()
  await mode.click()
  const digestWait = page.waitForResponse(
    (response) =>
      response.url().includes('/doraemon-paper-reader/api/compare/digests') &&
      response.request().method() === 'POST',
    { timeout: 30000 },
  )
  await page.getByRole('button', { name: /^开始对照/ }).click()
  await page.locator('.dpr-comparePanel').waitFor({ state: 'visible', timeout: 30000 })
  const digestResponse = await digestWait
  const digestPayload = await digestResponse.json().catch(() => ({}))
  if (!digestPayload.preflight) {
    throw new Error('compare/digests 没有返回 preflight：' + JSON.stringify(digestPayload))
  }
  await page.locator('.dpr-cmpSurveyBrief').waitFor({ state: 'visible', timeout: 30000 })
  return jobIds
}

async function screenshot(name) {
  const file = path.join(outDir, name)
  await page.screenshot({ path: file, fullPage: false })
  screenshots.push(file)
}

async function generateTable() {
  const wait = page.waitForResponse(
    (response) =>
      response.url().includes('/doraemon-paper-reader/api/compare/table') &&
      response.request().method() === 'POST',
    { timeout: 180000 },
  )
  await page.getByRole('button', { name: '生成对照表', exact: true }).click()
  const response = await wait
  const payload = await response.json().catch(() => ({}))
  return { status: response.status(), payload }
}

async function downloadReport(name) {
  const wait = page.waitForEvent('download', { timeout: 120000 })
  await page.getByRole('button', { name: '导出报告', exact: true }).click()
  const download = await wait
  const target = path.join(outDir, name)
  await download.saveAs(target)
  return target
}

try {
  const positiveIds = await openSurvey(tasks.methodPositive, '2 篇方法对照')
  const positiveBrief = (await page.locator('.dpr-cmpSurveyBrief').innerText()).trim()
  if (!/适合对照|有限可比/.test(positiveBrief)) errors.push('正例没有显示可对照预检：' + positiveBrief)
  await screenshot('method-preflight.png')
  const methodTable = await generateTable()
  if (methodTable.payload.kind !== 'survey-table') {
    errors.push('正例未生成 survey-table：' + JSON.stringify(methodTable.payload))
  }
  evidence.method = {
    jobIds: positiveIds,
    kind: methodTable.payload.kind,
    stats: methodTable.payload.table?.stats || null,
    preflight: methodTable.payload.preflight || null,
  }
  await page.getByRole('button', { name: '研究缺口', exact: true }).click()
  await page.locator('.dpr-cmpSide').getByText('研究缺口', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 30000,
  }).catch(() => {})
  const methodReportPath = await downloadReport('method-survey-report.md')
  const methodReport = await readFile(methodReportPath, 'utf8')
  if (!/有原文证据的对照/.test(methodReport)) errors.push('方法对照报告缺少证据区')
  evidence.method.reportPath = methodReportPath
  await screenshot('method-report.png')
  await page.locator('.dpr-compareHeader .dpr-compareClose').click()

  await openSurvey(tasks.negative, '2 篇方法对照', { direct: true })
  const negativeBrief = (await page.locator('.dpr-cmpSurveyBrief').innerText()).trim()
  if (!negativeBrief.includes('不建议直接对照')) {
    errors.push('负例没有显示不可比提示：' + negativeBrief)
  }
  const negativeTable = await generateTable()
  evidence.negative = {
    brief: negativeBrief,
    kind: negativeTable.payload.kind,
    preflight: negativeTable.payload.preflight || null,
  }
  if (negativeTable.payload.kind !== 'not-comparable') {
    errors.push('负例仍然生成了对照表：' + JSON.stringify(negativeTable.payload))
  }
  await page.locator('.dpr-cmpTopError').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
  await screenshot('negative-rejected.png')
  await page.locator('.dpr-compareHeader .dpr-compareClose').click()

  const gapIds = await openSurvey(tasks.gapTask, '3 篇研究缺口')
  const gapBrief = (await page.locator('.dpr-cmpSurveyBrief').innerText()).trim()
  if (!gapBrief.includes('3 篇研究缺口')) errors.push('三篇任务没有显示研究缺口模式：' + gapBrief)
  const gapTable = await generateTable()
  evidence.gap = {
    jobIds: gapIds,
    kind: gapTable.payload.kind,
    stats: gapTable.payload.table?.stats || null,
    preflight: gapTable.payload.preflight || null,
  }
  if (gapTable.payload.kind !== 'survey-table') errors.push('三篇研究缺口未生成表格')
  if ((gapTable.payload.table?.stats?.gapsGrounded || 0) === 0 &&
      (gapTable.payload.table?.stats?.gapsInference || 0) === 0) {
    errors.push('研究缺口任务既没有 grounded gap，也没有模型归纳缺口')
  }
  await page.getByRole('button', { name: '研究缺口', exact: true }).click()
  await page.locator('.dpr-cmpArtText').filter({ hasText: '跨论文关系与研究缺口' }).waitFor({
    state: 'visible',
    timeout: 30000,
  })
  const gapArtifactText = await page
    .locator('.dpr-cmpArtText')
    .filter({ hasText: '跨论文关系与研究缺口' })
    .first()
    .innerText()
  evidence.gap.artifactHasRelations = gapArtifactText.includes('共同覆盖、差异、冲突与互补')
  evidence.gap.artifactHasInference = gapArtifactText.includes('模型归纳')
  if (!evidence.gap.artifactHasRelations || !evidence.gap.artifactHasInference) {
    errors.push('研究缺口产物没有同时展示跨论文关系和模型归纳')
  }
  const gapReportPath = await downloadReport('gap-survey-report.md')
  const gapReport = await readFile(gapReportPath, 'utf8')
  if (!/证据边界/.test(gapReport)) errors.push('综述报告缺少证据边界')
  evidence.gap.reportPath = gapReportPath
  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(1500)
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('.dpr-comparePanel')
    const root = document.querySelector('.dpr-compareRoot')
    return {
      overflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : true,
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX },
      rootRect: root
        ? {
            left: root.getBoundingClientRect().left,
            top: root.getBoundingClientRect().top,
            width: root.getBoundingClientRect().width,
            height: root.getBoundingClientRect().height,
          }
        : null,
      panelRect: panel
        ? {
            left: panel.getBoundingClientRect().left,
            top: panel.getBoundingClientRect().top,
            width: panel.getBoundingClientRect().width,
            height: panel.getBoundingClientRect().height,
            clientWidth: panel.clientWidth,
            scrollWidth: panel.scrollWidth,
          }
        : null,
      panelStyle: panel
        ? {
            position: getComputedStyle(panel).position,
            display: getComputedStyle(panel).display,
            visibility: getComputedStyle(panel).visibility,
            opacity: getComputedStyle(panel).opacity,
            zIndex: getComputedStyle(panel).zIndex,
            textStart: String(panel.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
          }
        : null,
      offenders: panel
        ? [...panel.querySelectorAll('*')]
            .map((element) => {
              const rect = element.getBoundingClientRect()
              return {
                tag: element.tagName.toLowerCase(),
                className: String(element.className || '').slice(0, 120),
                width: Math.round(rect.width),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                scrollWidth: element.scrollWidth,
              }
            })
            .filter(
              (item) =>
                item.right > window.innerWidth + 1 ||
                item.scrollWidth > window.innerWidth + 1 ||
                item.width > window.innerWidth + 1,
            )
            .sort((left, right) => right.width - left.width)
            .slice(0, 12)
        : [],
    }
  })
  evidence.narrow = overflow
  if (overflow.overflow) errors.push('375px 对照面板出现横向溢出：' + JSON.stringify(overflow))
  const narrowShot = path.join(outDir, 'gap-375.png')
  await page.locator('.dpr-comparePanel').screenshot({ path: narrowShot })
  screenshots.push(narrowShot)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(500)
  await screenshot('gap-dark.png')
  await page.emulateMedia({ colorScheme: null })
} catch (error) {
  errors.push(String(error?.stack || error))
  await screenshot('survey-failure.png').catch(() => {})
} finally {
  const report = {
    generatedAt: new Date().toISOString(),
    taskReport: path.resolve(args.taskReport),
    outDir,
    evidence,
    screenshots,
    errors,
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  if (errors.length > 0) process.exitCode = 1
}
