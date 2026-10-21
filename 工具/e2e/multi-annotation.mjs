#!/usr/bin/env node
// L2：两篇论文的未发送批注能否在同一条主消息前一起出现。
//
// 做法：给两篇真实作业各写一条临时批注 → 刷新 → 回到主界面 → 批注条应显示两篇论文；
// 跑完把两篇的原存档写回，不留测试批注。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/multi-annotation.mjs --url "http://127.0.0.1:3117/?token=…" [--out <dir>]

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') out.url = argv[++i]
    else if (token === '--out') out.out = argv[++i]
    else if (token === '--profile') out.profile = argv[++i]
    else if (token === '--headed') out.headless = false
    else throw new Error('未知参数：' + token)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url（dev 实例打印出来的带 token 地址）')

const profileDir = path.resolve(args.profile ?? '工具/gen/_e2e-compare-profile')
const outDir = path.resolve(
  args.out ?? '工具/gen/compare-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
)
const errors = []
const findings = []

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

let backups = []

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await openMainInterface()

  const targets = await page.evaluate(async () => {
    const library = await (await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })).json()
    return (library.papers || []).slice(0, 2).map((paper) => ({ jobId: paper.jobId, title: paper.title }))
  })
  if (targets.length < 2) throw new Error('论文库少于 2 篇')

  for (const [index, target] of targets.entries()) {
    const block = await page.evaluate(async (jobId) => {
      const doc = await (
        await fetch('doraemon-paper-reader/api/jobs/' + jobId + '/mirrordoc.json', { cache: 'no-store' })
      ).json()
      const found = (doc.blocks || []).find(
        (item) => item.type === 'paragraph' && String(item.text || '').length > 120 && item.id,
      )
      return found
        ? { blockId: found.id, page: found.page || 1, section: found.section || '正文', text: found.text }
        : null
    }, target.jobId)
    if (!block) throw new Error('找不到真实段落：' + target.title)
    const original = await page.evaluate(async (jobId) => {
      const response = await fetch('doraemon-paper-reader/api/jobs/' + jobId + '/annotations', { cache: 'no-store' })
      return response.ok ? response.json() : { items: [] }
    }, target.jobId)
    backups.push({ jobId: target.jobId, items: original.items || [] })
    const item = {
      id: 'ann-e2e-' + index + '-' + Date.now(),
      jobId: target.jobId,
      question: '跨论文批注测试 ' + (index + 1),
      sent: false,
      createdAt: new Date().toISOString(),
      context: { paper: { title: target.title } },
      segments: [
        {
          quote: block.text.slice(0, 180),
          before: '',
          after: '',
          page: block.page,
          blockId: block.blockId,
          section: block.section,
          kind: 'text',
        },
      ],
    }
    await page.evaluate(
      async ({ jobId, items }) => {
        const response = await fetch('doraemon-paper-reader/api/jobs/' + jobId + '/annotations', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        })
        if (!response.ok) throw new Error(await response.text())
      },
      { jobId: target.jobId, items: [...(original.items || []), item] },
    )
  }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openMainInterface()
  await page.locator('.dpr-annotationDock').waitFor({ state: 'visible', timeout: 15000 })
  const summary = (await page.locator('.dpr-annotationSummary').first().innerText()).trim()
  const paperMatch = summary.match(/(\d+)\s*篇论文/)
  if (!paperMatch || Number(paperMatch[1]) < 2) {
    findings.push('批注条没有把两篇论文的批注并在一起：' + summary)
  }
  const dockText = (await page.locator('.dpr-annotationDock').first().innerText()).trim()
  for (const target of targets) {
    if (!dockText.includes(target.title.slice(0, 12))) {
      findings.push('批注条里看不到论文：' + target.title.slice(0, 24))
    }
  }
  await mkdir(outDir, { recursive: true })
  await page.locator('.dpr-annotationDock').first().screenshot({ path: path.join(outDir, 'multi-annotation-dock.png') })
  console.log('批注条：' + summary)
  console.log('截图：' + path.join(outDir, 'multi-annotation-dock.png'))

  const composer = page.locator('[data-composer-input]').last()
  await composer.fill('这两段分别在讲什么？请按论文分别回答，再给一句它们的关系。')
  await composer.press('Enter')
  let sent = false
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(1000)
    const text = await page.evaluate(() => document.body.innerText)
    if (/跨 \d+ 篇论文的 \d+ 条批注/.test(text)) {
      sent = true
      break
    }
  }
  if (!sent) findings.push('主对话里没有出现跨论文批注摘要')
  let tool = false
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(1000)
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes('读取大肥鱼批注') || text.includes('doraemon_read_annotations')) {
      tool = true
      break
    }
  }
  if (!tool) findings.push('模型没有调用 doraemon_read_annotations')
  await page.screenshot({ path: path.join(outDir, 'multi-annotation-sent.png') })
  console.log('同一次发送：' + (sent ? '摘要已出现' : '未出现') + ' / 工具调用：' + (tool ? '已出现' : '未出现'))
} finally {
  for (const backup of backups) {
    await page
      .evaluate(
        async ({ jobId, items }) => {
          await fetch('doraemon-paper-reader/api/jobs/' + jobId + '/annotations', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
          })
        },
        { jobId: backup.jobId, items: backup.items },
      )
      .catch(() => {})
  }
  console.log('页面 console error：' + (errors.length === 0 ? '无' : errors.join(' || ')))
  console.log(findings.length === 0 ? '结论：多篇批注条 L2 通过' : '结论：不通过 → ' + findings.join('；'))
  if (findings.length > 0) process.exitCode = 1
  await context.close()
}
