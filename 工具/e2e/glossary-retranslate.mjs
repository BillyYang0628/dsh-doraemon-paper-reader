#!/usr/bin/env node
// L2：术语表保存 → 真正启动重译 → 状态完成；跑完恢复术语/译文/缓存。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/glossary-retranslate.mjs --url "http://127.0.0.1:3117/?token=…" [--out <dir>]

import { createRequire } from 'node:module'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--headed') out.headless = false
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url')
const outDir = path.resolve(
  args.out ?? '工具/gen/glossary-retranslate-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
)
const jobRoot = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'doraemon-paper-reader', 'jobs')
  : 'D:\\DSH\\home\\doraemon-paper-reader\\jobs'
const backupDir = path.join(outDir, 'backup')
const files = ['glossary.json', 'translations.zh.json', 'translations-cache.json']
const backups = []
const errors = []
const context = await chromium.launchPersistentContext(
  path.resolve('工具/gen/_e2e-glossary-profile'),
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

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  await page.waitForTimeout(450)
  return true
}

let jobId = ''
try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
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
  await page.locator('.dpr-surveyCard').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-surveyCard').first().click()
  const rows = page.locator('.dpr-surveyRow')
  await rows.first().waitFor({ state: 'visible', timeout: 10000 })
  const plague = rows.filter({ hasText: 'Multiple Antimicrobial Resistance' }).first()
  const sticker = rows.filter({ hasText: 'Smart Sticker' }).first()
  await plague.locator('input[type=checkbox]').check()
  await sticker.locator('input[type=checkbox]').check()
  await page.getByRole('button', { name: /开始对照/ }).first().click()
  await page.locator('.dpr-cmpPaperPane').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-cmpBlock').first().waitFor({ state: 'visible', timeout: 20000 })

  jobId = await page.evaluate(async () => {
    const library = await (await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })).json()
    return (library.papers || []).find((paper) => /Multiple Antimicrobial Resistance/.test(paper.title))?.jobId || ''
  })
  if (!jobId) throw new Error('找不到 Plague 作业')
  await mkdir(backupDir, { recursive: true })
  for (const file of files) {
    const source = path.join(jobRoot, jobId, file)
    try {
      await copyFile(source, path.join(backupDir, file))
      backups.push({ source, backup: path.join(backupDir, file) })
    } catch {
      // 没有这个文件就不备份。
    }
  }

  const pane = page.locator('.dpr-cmpPaperPane').first()
  await pane.locator('.dpr-cmpLangBtn').first().click()
  await page.waitForTimeout(1200)
  await pane.getByRole('button', { name: '术语', exact: true }).click()
  await page.locator('.dpr-citeOverlay').waitFor({ state: 'visible', timeout: 10000 })
  await page.getByRole('button', { name: '添加术语', exact: true }).click()
  const lastRow = page.locator('.dpr-glossaryRow').last()
  await lastRow.locator('input[type=text]').nth(0).fill('TESTTERM_L2')
  await lastRow.locator('input[type=text]').nth(1).fill('测试术语')
  await page.getByRole('button', { name: '保存并重译', exact: true }).click()
  await page.locator('.dpr-citeOverlay').waitFor({ state: 'hidden', timeout: 15000 })

  let status = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    status = await page.evaluate(async (targetJobId) => {
      const response = await fetch(
        'doraemon-paper-reader/api/jobs/' + targetJobId + '/translate',
        { cache: 'no-store' },
      )
      if (!response.ok) return 'http-' + response.status
      const payload = await response.json()
      return String(payload.status || 'unknown')
    }, jobId)
    if (status === 'done' || status === 'failed') break
    await page.waitForTimeout(2000)
  }
  const glossary = await page.evaluate(async (targetJobId) => {
    const response = await fetch(
      'doraemon-paper-reader/api/jobs/' + targetJobId + '/glossary',
      { cache: 'no-store' },
    )
    return response.ok ? response.json() : null
  }, jobId)
  const saved = (glossary?.entries || []).some((entry) => entry.source === 'TESTTERM_L2')
  if (status !== 'done') errors.push('重译没有完成：' + status)
  if (!saved) errors.push('术语没有保存：TESTTERM_L2')
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'glossary-retranslate.png') })
  console.log(JSON.stringify({ jobId, status, saved, errors }, null, 2))
  if (errors.length > 0) process.exitCode = 1
} finally {
  for (const item of backups) {
    await copyFile(item.backup, item.source).catch(() => {})
  }
  await context.close()
}
