#!/usr/bin/env node
// B7 L2：灵感模式批注显式调用 doraemon_search_novelty，并展示谨慎查新状态。

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

const question = '从这段提出一个可验证创意，并调用查新工具核对相似工作。'
const outDir = path.resolve(args.out ?? '工具/gen/B7-20261022/e2e/novelty')
const errors = []
await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-b7-novelty-profile'),
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

async function cleanup() {
  await page.evaluate(async ({ jobId, text }) => {
    const api = '/doraemon-paper-reader/api/jobs/' + jobId + '/annotations'
    const current = await fetch(api, { cache: 'no-store' }).then((response) => response.json())
    const items = (current.items || []).filter((item) => item.question !== text)
    await fetch(api, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
  }, { jobId: args.job, text: question }).catch(() => {})
}

try {
  await page.addInitScript((jobId) => {
    try {
      window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
      window.localStorage.setItem('doraemonPaperReader.readerMode.' + jobId, 'inspiration')
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

  const inspiration = page.getByRole('radio', { name: '灵感模式', exact: true })
  if ((await inspiration.getAttribute('aria-checked')) !== 'true') {
    await inspiration.click()
  }
  if ((await inspiration.getAttribute('aria-checked')) !== 'true') errors.push('灵感模式没有启用')

  const selected = await page.evaluate(() => {
    const text = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')]
      .find((element) => /MobileViT/i.test(element.textContent || '') && String(element.textContent || '').length > 180)
    if (!text) return false
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(300, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    text.closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) errors.push('没有找到 MobileViT 正文选区')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '问大肥鱼', exact: true }).last().click()
  await page.waitForTimeout(300)
  await page.locator('.dpr-annotationItem textarea').last().fill(question)
  const composer = page.locator('[data-composer-input]').last()
  await composer.click()
  await composer.fill(
    question +
      ' 请显式调用 doraemon_search_novelty，检索 adaptive patch routing lightweight vision transformer，' +
      '并根据真实候选说明相似程度；没有充分证据时写“当前检索未发现”，不得声称绝对新颖。',
  )
  await page.keyboard.press('Enter')

  const userBubble = page.locator('text=/批次：batch_/').last()
  await userBubble.waitFor({ state: 'visible', timeout: 15000 })
  const userText = await userBubble.innerText()
  if (!/灵感模式/.test(userText)) errors.push('用户消息没有携带灵感模式')

  const sawTool = await page
    .waitForFunction(
      () =>
        /工具调用\s*·\s*doraemon_search_novelty/.test(document.body.innerText),
      null,
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!sawTool) errors.push('120 秒内没有看到 doraemon_search_novelty 工具调用')
  const answerFinished = await page
    .waitForFunction(
      () => /原文回跳|原段回跳|回跳原文/.test(document.body.innerText),
      null,
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!answerFinished) errors.push('120 秒内没有看到查新后的最终回答与回跳')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(outDir, 'novelty-answer.png') })
  const bodyText = await page.locator('body').innerText()
  if (!/当前检索未发现|部分相关|高度相似|未查新/.test(bodyText)) {
    errors.push('回答没有给出谨慎查新状态')
  }
} catch (error) {
  errors.push(String(error))
  await page.screenshot({ path: path.join(outDir, 'failed.png') }).catch(() => {})
} finally {
  await cleanup()
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors }, null, 2), 'utf8')
  await context.close()
}

console.log(JSON.stringify({ out: outDir, errors }, null, 2))
if (errors.length > 0) process.exitCode = 1
