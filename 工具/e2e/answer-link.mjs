#!/usr/bin/env node
// L2：聊天回答里的 citationDeepLink 能打开阅读页并高亮原段。

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
  else if (process.argv[i] === '--headed') args.headless = false
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const outDir = path.resolve(args.out ?? '工具/gen/answer-link-20261020')
const errors = []
const question = '回答链接回跳测试：请解释这段在论文中的作用。'
await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-answer-link-profile'), {
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

async function cleanupTestAnnotations() {
  await page.evaluate(async ({ jobId, text }) => {
    const api = '/doraemon-paper-reader/api/jobs/' + jobId + '/annotations'
    const current = await fetch(api, { cache: 'no-store' }).then((response) => response.json())
    const items = (current.items || []).filter((item) => item.question !== text)
    await fetch(api, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
  }, { jobId: args.job, text: question })
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
  await page.waitForTimeout(500)

  const selected = await page.evaluate(() => {
    const text = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')]
      .find((element) => String(element.textContent || '').trim().length > 120)
    if (!text) return false
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(100, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    text.closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) errors.push('无法建立正文选区')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '问大肥鱼', exact: true }).last().click()
  await page.waitForTimeout(500)
  const annotationQuestion = page.locator('.dpr-annotationItem textarea').last()
  await annotationQuestion.fill(question)

  const composer = page.locator('[data-composer-input]').last()
  await composer.click()
  await composer.fill(
    '请先调用 doraemon_read_annotations。回答这段原文时，必须使用工具结果里的 citationDeepLink，格式为 [p.页码](dsh-resource://doraemon-paper/...)，不要改成文件路径。',
  )
  await page.keyboard.press('Enter')

  const link = page.locator('a[href*="/doraemon-paper-reader/api/open?"]').last()
  const found = await link
    .waitFor({ state: 'visible', timeout: 90000 })
    .then(() => true)
    .catch(() => false)
  await page.screenshot({ path: path.join(outDir, 'answer-with-link.png') })
  if (!found) errors.push('聊天里没有渲染 citationUrl 回跳链接')
  if (found) {
    const href = await link.getAttribute('href')
    await link.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(outDir, 'answer-with-link.png') })
    await link.click()
    await page.waitForTimeout(1200)
    if ((await page.locator('.dpr-readerTitle').count()) === 0) errors.push('点击回答链接没有打开阅读页')
    const flashed = await page
      .locator('.dpr-flash')
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (!flashed) errors.push('点击回答链接后原段没有高亮')
    await page.screenshot({ path: path.join(outDir, 'answer-jump.png') })
    await writeFile(path.join(outDir, 'href.txt'), String(href || ''), 'utf8')
  }
} finally {
  await cleanupTestAnnotations().catch(() => {})
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length) process.exitCode = 1
