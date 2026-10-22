#!/usr/bin/env node
// P3：真实 DSH 知识中心——跨论文检索、证据问答、引用图、导出、阅读档案。

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
    else if (arg === '--out') out.out = argv[++index]
    else if (arg === '--profile') out.profile = argv[++index]
    else throw new Error('未知参数：' + arg)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(args.out ?? '工具/gen/P3-20261022/e2e/knowledge-center')
const errors = []
const screenshots = []
const evidence = {}
await mkdir(outDir, { recursive: true })

let browser
let page
if (args.url) {
  browser = await chromium.launchPersistentContext(
    path.resolve(args.profile ?? '工具/gen/_p3-knowledge-profile'),
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

async function openKnowledge() {
  if (!(await page.locator('.dpr-knowledgePane').isVisible().catch(() => false))) {
    if (!(await page.locator('.dpr-homePane').isVisible().catch(() => false))) await openHome()
    await page
      .locator('button.dpr-homeDocManager')
      .filter({ hasText: '知识中心' })
      .click()
    await page.locator('.dpr-knowledgePane').waitFor({ state: 'visible', timeout: 30000 })
  }
}

async function screenshot(name) {
  const file = path.join(outDir, name)
  await page.screenshot({ path: file, fullPage: false })
  screenshots.push(file)
}

async function download(name, buttonName) {
  const wait = page.waitForEvent('download', { timeout: 60000 })
  await page.getByRole('button', { name: buttonName, exact: true }).click()
  const file = await wait
  const target = path.join(outDir, name)
  await file.saveAs(target)
  return target
}

try {
  await openHome()
  await openKnowledge()
  await page.waitForTimeout(1000)
  evidence.status = await page.evaluate(async () => {
    const response = await fetch('doraemon-paper-reader/api/knowledge', { cache: 'no-store' })
    return response.json()
  })
  if ((evidence.status.stats?.total || 0) === 0) errors.push('知识索引为空')

  const searchInput = page.getByRole('textbox', { name: '跨论文知识搜索' })
  await searchInput.fill('MobileViT')
  const searchWait = page.waitForResponse(
    (response) =>
      response.url().includes('/doraemon-paper-reader/api/knowledge/search') &&
      response.request().method() === 'POST',
    { timeout: 30000 },
  )
  await page.getByRole('button', { name: '检索', exact: true }).click()
  const searchResponse = await searchWait
  evidence.search = await searchResponse.json()
  if (!Array.isArray(evidence.search.results) || evidence.search.results.length === 0) {
    errors.push('MobileViT 知识检索没有结果')
  }
  if (!evidence.search.results.every((item) => item.jobId && item.sourceType)) {
    errors.push('知识检索结果缺少 jobId/sourceType')
  }
  if (!evidence.search.results.some((item) => item.blockId)) {
    errors.push('知识检索结果没有 blockId')
  }
  await page.locator('.dpr-knowledgePaperGroup').first().waitFor({ state: 'visible', timeout: 20000 })
  await screenshot('search-results.png')

  const answerWait = page.waitForResponse(
    (response) =>
      response.url().includes('/doraemon-paper-reader/api/knowledge/answer') &&
      response.request().method() === 'POST',
    { timeout: 120000 },
  )
  await page.getByRole('button', { name: '证据问答', exact: true }).click()
  const answerResponse = await answerWait
  evidence.answer = await answerResponse.json()
  if (!evidence.answer.answer) errors.push('知识证据问答没有回答')
  await page.locator('.dpr-knowledgeAnswer').waitFor({ state: 'visible', timeout: 20000 })
  await screenshot('evidence-answer.png')

  const firstResult = page.locator('.dpr-knowledgeResult').first()
  const firstResultText = (await firstResult.innerText()).trim()
  await firstResult.click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  evidence.openedFromSearch = firstResultText.slice(0, 120)
  await page.waitForTimeout(2200)

  await openHome()
  await openKnowledge()
  await page.waitForTimeout(700)
  const papers = await page.evaluate(async () => {
    const response = await fetch('doraemon-paper-reader/api/knowledge/profile', { cache: 'no-store' })
    return response.json()
  })
  evidence.profileBefore = {
    totalReadingSeconds: papers.totalReadingSeconds,
    papersRead: papers.papersRead,
  }
  if ((papers.totalReadingSeconds || 0) <= 0) errors.push('阅读档案没有累计阅读时长')

  const select = page.getByRole('combobox', { name: '选择引用图谱中心论文' })
  const option = page
    .locator('option')
    .filter({ hasText: 'A Smart AIoT-Based Mobile Application' })
    .first()
  const jobId = await option.getAttribute('value')
  if (!jobId) throw new Error('没有找到 AIoT 引用图谱论文')
  await select.selectOption(jobId)
  await page.locator('.dpr-knowledgeGraph').waitFor({ state: 'visible', timeout: 30000 })
  evidence.graph = await page.evaluate(async (id) => {
    const response = await fetch(
      'doraemon-paper-reader/api/jobs/' + encodeURIComponent(id) + '/citation-graph',
      { cache: 'no-store' },
    )
    return response.json()
  }, jobId)
  if (!Array.isArray(evidence.graph.edges) || evidence.graph.edges.length === 0) {
    errors.push('引用图谱没有边')
  }
  await screenshot('citation-graph.png')

  const annotationFile = await download('paper-annotations.md', '批注 Markdown')
  evidence.annotationExport = await readFile(annotationFile, 'utf8')
  const glossaryFile = await download('paper-glossary.csv', '术语 CSV')
  evidence.glossaryExport = await readFile(glossaryFile, 'utf8')
  if (!evidence.annotationExport.includes('批注')) errors.push('批注导出内容异常')
  if (!evidence.glossaryExport.includes('source,target')) errors.push('术语 CSV 表头异常')

  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(700)
  const overflow = await page.evaluate(() => {
    const pane = document.querySelector('.dpr-knowledgePane')
    return {
      clientWidth: pane?.clientWidth || 0,
      scrollWidth: pane?.scrollWidth || 0,
    }
  })
  evidence.narrow = overflow
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    errors.push('375px 知识中心横向溢出：' + JSON.stringify(overflow))
  }
  await screenshot('knowledge-375.png')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(500)
  await screenshot('knowledge-dark.png')
  await page.emulateMedia({ colorScheme: null })
} catch (error) {
  errors.push(String(error?.stack || error))
  await screenshot('knowledge-failure.png').catch(() => {})
} finally {
  const report = {
    generatedAt: new Date().toISOString(),
    outDir,
    screenshots,
    errors,
    evidence: {
      status: evidence.status || null,
      searchCount: evidence.search?.results?.length || 0,
      groupCount: evidence.search?.groups?.length || 0,
      answerSources: evidence.answer?.sources?.length || 0,
      graphCoverage: evidence.graph?.coverage || null,
      profileBefore: evidence.profileBefore || null,
      narrow: evidence.narrow || null,
      openedFromSearch: evidence.openedFromSearch || '',
    },
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  if (errors.length > 0) process.exitCode = 1
}
