#!/usr/bin/env node
// L2：摘要区与正文共用批注链路。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/summary-annotation.mjs --url "http://127.0.0.1:3116/?token=…"

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') out.url = argv[++i]
    else if (token === '--title') out.title = argv[++i]
    else if (token === '--out') out.out = argv[++i]
    else if (token === '--profile') out.profile = argv[++i]
    else if (token === '--headed') out.headless = false
    else throw new Error('未知参数：' + token)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url（dev 实例打印出来的带 token 地址）')

const title = args.title ?? 'Sharing Detailed Research Data Is Associated with Increased Citation Rate'
const outDir = path.resolve(args.out ?? '工具/gen/summary-annotation-20261020')
const profileDir = path.resolve(args.profile ?? '工具/gen/_e2e-summary-profile')
const errors = []
let jobId = ''
let originalItems = null

await mkdir(outDir, { recursive: true })
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push('HTTP ' + response.status() + ' ' + response.url())
})

async function clickIfVisible(name, timeout = 800) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click({ timeout })
  return true
}

async function openMainInterface() {
  await page.keyboard.press('Control+Alt+N')
  await page.waitForTimeout(1500)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(500)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(700)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1600)
  }
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
}

async function openPaperByTitle(expected) {
  await openMainInterface()
  const item = page.locator('.dpr-libraryItem').filter({ hasText: expected }).first()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const actual = (await page.locator('.dpr-readerTitle').innerText()).trim()
  if (!actual.includes(expected)) errors.push('打开的论文标题不对：' + JSON.stringify(actual))
}

async function readJobId(expectedTitle) {
  const library = await page.evaluate(async () => {
    const response = await fetch('/doraemon-paper-reader/api/library', { cache: 'no-store' })
    return response.json()
  })
  const paper = library.papers.find((entry) => entry.title.includes(expectedTitle))
  return paper?.jobId || ''
}

try {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('doraemonPaperReader.lastJobId')
    } catch {
      // localStorage 在受限 profile 里可能不可用。
    }
  })
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await openPaperByTitle(title)
  jobId = await readJobId(title)
  if (!jobId) errors.push('论文库里找不到测试论文')
  if (jobId) {
    const current = await page.evaluate(async (id) => {
      const response = await fetch('/doraemon-paper-reader/api/jobs/' + id + '/annotations', { cache: 'no-store' })
      return response.json()
    }, jobId)
    const withoutTestItems = (current.items || []).filter(
      (entry) => !String(entry.question || '').includes('摘要批注测试'),
    )
    originalItems = withoutTestItems
    await page.evaluate(
      async ({ id, items }) => {
        await fetch('/doraemon-paper-reader/api/jobs/' + id + '/annotations', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        })
      },
      { id: jobId, items: withoutTestItems },
    )
  }

  const abstract = page.locator('.dpr-readerAbstract[data-block-id="__meta_abstract"]').first()
  await abstract.waitFor({ state: 'visible', timeout: 10000 })
  const attributes = await abstract.evaluate((element) => ({
    page: element.dataset.page,
    section: element.dataset.section,
    sourceLength: String(element.dataset.sourceText || '').length,
    paragraphCount: element.querySelectorAll('.dpr-readerP').length,
  }))
  if (attributes.page !== '1') errors.push('摘要页码不是 1：' + attributes.page)
  if (attributes.section !== 'Abstract') errors.push('摘要 section 不是 Abstract：' + attributes.section)
  if (attributes.sourceLength < 100) errors.push('摘要 data-source-text 太短：' + attributes.sourceLength)
  if (attributes.paragraphCount < 1) errors.push('摘要没有可选择的正文段落')

  const selected = await page.evaluate(() => {
    const text = document.querySelector('.dpr-readerAbstract[data-block-id="__meta_abstract"] .dpr-readerP')
    if (!text) return false
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(96, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    text.closest('[data-block-id]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) errors.push('无法在摘要区建立选区')
  await page.waitForTimeout(350)

  const bar = page.locator('.dpr-selectionBar').last()
  await bar.waitFor({ state: 'visible', timeout: 5000 })
  const question = bar.locator('textarea')
  if ((await question.count()) === 0) errors.push('摘要选区浮层没有批注输入框')
  else await question.fill('摘要批注测试：这与后文的引用结果有什么关系？')
  await bar.getByRole('button', { name: '问大肥鱼', exact: true }).click()
  await page.waitForTimeout(700)

  const dockText = (await page.locator('.dpr-annotationDock').last().innerText().catch(() => '')).trim()
  if (!dockText.includes('1 个批注')) errors.push('摘要批注没有进入主对话批注条：' + JSON.stringify(dockText))
  const itemQuestion = await page
    .locator('.dpr-annotationItem textarea')
    .last()
    .inputValue()
    .catch(() => '')
  if (!itemQuestion.includes('摘要批注测试')) errors.push('摘要批注问题没有保留在批注条：' + JSON.stringify(itemQuestion))
  await page.screenshot({ path: path.join(outDir, 'summary-in-dock.png') })

  const saved = await page.evaluate(async () => {
    if (!document.querySelector('[data-block-id="__meta_abstract"]')) return null
    const api = '/doraemon-paper-reader/api/'
    const library = await fetch(api + 'library', { cache: 'no-store' }).then((response) => response.json())
    const paper = library.papers.find((entry) =>
      entry.title.includes('Sharing Detailed Research Data Is Associated with Increased Citation Rate'),
    )
    if (!paper) return null
    const current = await fetch(api + 'jobs/' + paper.jobId + '/annotations', { cache: 'no-store' }).then((response) =>
      response.json(),
    )
    const item = current.items.find((entry) =>
      entry.segments?.some((segment) => segment.blockId === '__meta_abstract'),
    )
    if (!item) return { jobId: paper.jobId, found: false }
    item.sent = true
    const response = await fetch(api + 'jobs/' + paper.jobId + '/annotations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: current.items }),
    })
    return { jobId: paper.jobId, found: true, status: response.status }
  })
  if (!saved?.found || saved.status !== 200) {
    errors.push('摘要批注没有按预期落盘：' + JSON.stringify({ jobId, saved }))
  }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  if ((await page.locator('.dpr-readerAbstract[data-block-id="__meta_abstract"]').count()) === 0) {
    await openPaperByTitle(title)
  }
  const bubble = page.locator('.dpr-readerAbstract[data-block-id="__meta_abstract"] .dpr-bubble').first()
  await bubble.waitFor({ state: 'visible', timeout: 15000 })
  if ((await bubble.innerText()).trim() !== '1') errors.push('摘要段尾气泡数量不对')
  await bubble.click()
  await page.waitForTimeout(300)
  if ((await page.locator('.dpr-readerAbstract.dpr-flash').count()) === 0) {
    errors.push('点击摘要气泡没有触发高亮')
  }
  await page.screenshot({ path: path.join(outDir, 'summary-bubble.png') })
} finally {
  if (jobId && originalItems) {
    await page
      .evaluate(
        async ({ id, items }) => {
          await fetch('/doraemon-paper-reader/api/jobs/' + id + '/annotations', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
          })
        },
        { id: jobId, items: originalItems },
      )
      .catch(() => {})
  }
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ title, errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ title, outDir, errors }, null, 2))
if (errors.length > 0) process.exitCode = 1
