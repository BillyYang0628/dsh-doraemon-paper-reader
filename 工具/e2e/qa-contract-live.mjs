#!/usr/bin/env node
// B6 真实 DSH：批注证据模式 → 批次策略 → 工具读取 → 回答链路。

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
  else if (process.argv[index] === '--policy-only') args.policyOnly = true
}
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const question = '用一句话解释 MobileViT 是什么，并给出原文回跳。'
const outDir = path.resolve(args.out ?? '工具/gen/B6-20261022/e2e')
const errors = []
await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-b6-contract-profile'),
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
      window.localStorage.removeItem('doraemonPaperReader.answerPolicy')
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

  const selected = await page.evaluate(() => {
    const text = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')]
      .find((element) => /MobileViT/i.test(element.textContent || '') && String(element.textContent || '').length > 160)
    if (!text) return false
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(260, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    text.closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) errors.push('没有找到 MobileViT 正文选区')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '问大肥鱼', exact: true }).last().click()
  await page.waitForTimeout(400)

  const policy = page.locator('.dpr-answerPolicy')
  await policy.waitFor({ state: 'visible', timeout: 5000 })
  const modes = policy.getByRole('radio')
  if ((await modes.count()) !== 2) errors.push('回答证据范围没有两个选项')
  const defaultChecked = await modes.nth(0).getAttribute('aria-checked')
  if (defaultChecked !== 'true') errors.push('默认精读没有作为初始策略')
  await modes.nth(1).click()
  if ((await modes.nth(1).getAttribute('aria-checked')) !== 'true') {
    errors.push('只根据原文没有切换为选中状态')
  }
  const storedMode = await page.evaluate(() =>
    window.localStorage.getItem('doraemonPaperReader.answerPolicy'),
  )
  if (storedMode !== 'paper-only') errors.push('证据模式没有持久化：' + storedMode)
  await page.screenshot({ path: path.join(outDir, 'policy-mode.png') })

  if (args.policyOnly) {
    await cleanup()
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ errors, policyOnly: true }, null, 2), 'utf8')
    console.log(JSON.stringify({ out: outDir, policyOnly: true, errors }, null, 2))
    await context.close()
    process.exit(errors.length > 0 ? 1 : 0)
  }

  await page.locator('.dpr-annotationItem textarea').last().fill(question)
  const composer = page.locator('[data-composer-input]').last()
  const initialReturnLinks = await page
    .locator(
      'a[href*="/doraemon-paper-reader/api/open?"], a[href^="dsh-resource://doraemon-paper/"]',
    )
    .count()
  await composer.click()
  await composer.fill(question)
  await page.keyboard.press('Enter')

  const userBubble = page.locator('text=/批次：batch_/').last()
  await userBubble.waitFor({ state: 'visible', timeout: 15000 })
  const userText = (await userBubble.innerText()).trim()
  if (!/回答契约 B6/.test(userText)) errors.push('用户消息没有携带 B6 契约')
  if (!/只根据原文/.test(userText)) errors.push('用户消息没有携带只根据原文策略')
  const batchId = (userText.match(/batch_[a-f0-9]{24}/) || [])[0]
  if (!batchId) errors.push('用户消息没有批次号')

  if (batchId) {
    const batch = await page.evaluate(async (id) => {
      const response = await fetch(
        '/doraemon-paper-reader/api/annotation-batches/' + encodeURIComponent(id),
        { cache: 'no-store' },
      )
      return response.json()
    }, batchId)
    if (batch?.packet?.answerPolicy?.evidenceMode !== 'paper-only') {
      errors.push('批次没有持久化 paper-only 策略')
    }
  }

  const answerLinked = await page
    .waitForFunction(
      (initial) => {
        const links =
          document.querySelectorAll('a[href*="/doraemon-paper-reader/api/open?"]').length +
          document.querySelectorAll('a[href^="dsh-resource://doraemon-paper/"]').length
        return links >= initial + 2
      },
      initialReturnLinks,
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!answerLinked) errors.push('120 秒内没有出现“用户摘要 + 最终回答”的回跳链接')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(outDir, 'contract-answer.png') })
  const bodyText = await page.locator('body').innerText()
  if (/doraemon_read_annotations.*(?:失败|错误)|HTTP 4\d\d/.test(bodyText)) {
    errors.push('回答区出现工具调用失败')
  }
  if (!/MobileViT/.test(bodyText)) errors.push('回答区没有 MobileViT 内容')
  const finalReturnLinks = await page
    .locator(
      'a[href*="/doraemon-paper-reader/api/open?"], a[href^="dsh-resource://doraemon-paper/"]',
    )
    .count()
  if (finalReturnLinks < initialReturnLinks + 2) {
    errors.push('最终回答没有新增独立回跳链接')
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
