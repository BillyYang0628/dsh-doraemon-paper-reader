#!/usr/bin/env node
// B8 文档管理：批量入库、按需转义、重复识别、回收站、恢复、窄屏与亮暗主题。

import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = {
    cdp: 'http://127.0.0.1:9222',
    dataRoot: path.join(process.env.DSH_HOME || path.join('D:', 'DSH', 'home'), 'doraemon-paper-reader'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cdp') out.cdp = argv[++index]
    else if (arg === '--url') out.url = argv[++index]
    else if (arg === '--profile') out.profile = argv[++index]
    else if (arg === '--out') out.out = argv[++index]
    else if (arg === '--pdf') out.pdf = argv[++index]
    else if (arg === '--data-root') out.dataRoot = argv[++index]
    else if (arg === '--keep') out.keep = true
    else if (arg === '--cleanup-report') out.cleanupReport = argv[++index]
    else if (arg === '--cleanup-job') out.cleanupJob = argv[++index]
    else if (arg === '--expect-original-name') out.expectOriginalName = argv[++index]
    else throw new Error('未知参数：' + arg)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

async function cleanupReport(reportPath) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const removed = []
  const rejected = []
  for (const jobId of Array.isArray(report.testJobIds) ? report.testJobIds : []) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) {
      rejected.push({ jobId, reason: 'invalid-id' })
      continue
    }
    let removedOne = false
    for (const rootName of ['jobs', 'library-trash']) {
      const jobRoot = path.resolve(args.dataRoot, rootName)
      const target = path.resolve(jobRoot, jobId)
      if (!target.startsWith(jobRoot + path.sep)) {
        rejected.push({ jobId, reason: 'outside-data-root' })
        continue
      }
      try {
        const manifest = JSON.parse(await readFile(path.join(target, 'library-entry.json'), 'utf8'))
        if (!String(manifest.originalName || '').startsWith('B8 Audit ')) {
          rejected.push({ jobId, reason: 'not-b8-audit', root: rootName })
          continue
        }
        await rm(target, { recursive: true, force: true })
        removed.push({ jobId, root: rootName })
        removedOne = true
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          rejected.push({ jobId, reason: error?.message || String(error), root: rootName })
        }
      }
    }
    if (!removedOne) rejected.push({ jobId, reason: 'not-found' })
  }
  console.log(JSON.stringify({ cleanup: true, dataRoot: args.dataRoot, removed, rejected }, null, 2))
  if (rejected.some((item) => item.reason !== 'not-found')) process.exitCode = 1
}

async function cleanupExactJob(jobId, expectedOriginalName) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) throw new Error('非法 jobId')
  for (const rootName of ['jobs', 'library-trash']) {
    const jobRoot = path.resolve(args.dataRoot, rootName)
    const target = path.resolve(jobRoot, jobId)
    if (!target.startsWith(jobRoot + path.sep)) throw new Error('目标越出数据根目录')
    try {
      const manifest = JSON.parse(await readFile(path.join(target, 'library-entry.json'), 'utf8'))
      if (manifest.originalName !== expectedOriginalName) {
        throw new Error('manifest originalName 不匹配，拒绝清理')
      }
      await rm(target, { recursive: true, force: true })
      console.log(JSON.stringify({ cleanup: true, jobId, root: rootName, target }, null, 2))
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error('没有找到待清理作业')
}

if (args.cleanupJob) {
  if (!args.expectOriginalName) throw new Error('--cleanup-job 必须同时给 --expect-original-name')
  await cleanupExactJob(args.cleanupJob, args.expectOriginalName)
  process.exit()
}

if (args.cleanupReport) {
  await cleanupReport(args.cleanupReport)
  process.exit()
}

const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const outDir = path.resolve(args.out ?? '工具/gen/B8-20261022/e2e/library')
const errors = []
const screenshots = []
const testJobIds = []
const prefix = 'B8 Audit ' + Date.now()
await mkdir(outDir, { recursive: true })

let browser
let page
if (args.url) {
  browser = await chromium.launchPersistentContext(
    path.resolve(args.profile ?? '工具/gen/_b8-library-profile'),
    {
      channel: 'msedge',
      headless: true,
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
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
  await page.waitForTimeout(1400)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1400)
  }
  await page.locator('.dpr-homePane').waitFor({ state: 'visible', timeout: 30000 })
}

async function openLibrary() {
  if (!(await page.locator('.dpr-docPane').isVisible().catch(() => false))) {
    if (!(await page.locator('.dpr-homePane').isVisible().catch(() => false))) await openHome()
    await page.locator('button.dpr-homeDocManager').click()
    await page.locator('.dpr-docPane').waitFor({ state: 'visible', timeout: 30000 })
  }
}

async function managedLibrary() {
  return page.evaluate(async () => {
    const response = await fetch('doraemon-paper-reader/api/library?view=manage', {
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || response.statusText)
    return payload
  })
}

async function jobStatus(jobId) {
  return page.evaluate(async (id) => {
    const response = await fetch('doraemon-paper-reader/api/jobs/' + encodeURIComponent(id), {
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || response.statusText)
    return payload
  }, jobId)
}

async function waitReady(jobId, timeout = 180000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeout) {
    last = await jobStatus(jobId)
    if (last.libraryStatus === 'ready') return last
    if (last.libraryStatus === 'failed' || last.libraryStatus === 'missing') {
      throw new Error('测试论文转义失败：' + (last.error || last.message || last.libraryStatus))
    }
    await page.waitForTimeout(1500)
  }
  throw new Error('测试论文 180 秒内未完成转义：' + JSON.stringify(last))
}

async function screenshot(name) {
  const file = path.join(outDir, name)
  await page.screenshot({ path: file, fullPage: false })
  screenshots.push(file)
}

let sourcePdf = args.pdf
let temporaryInputDir = ''
try {
  if (!sourcePdf) {
    const library = await (async () => {
      await openHome()
      await openLibrary()
      return managedLibrary()
    })()
    const ready = library.items.find((item) => item.status === 'ready' && item.pipeline === 'pdf')
    if (!ready) throw new Error('未给 --pdf，且文档库里没有可用于 B8 回归的 PDF')
    sourcePdf = path.join(args.dataRoot, 'jobs', ready.jobId, 'original.pdf')
  }
  await stat(sourcePdf)

  await openHome()
  await openLibrary()
  await screenshot('library-before.png')

  temporaryInputDir = path.join(outDir, 'inputs')
  await mkdir(temporaryInputDir, { recursive: true })
  const sourceBytes = await readFile(sourcePdf)
  const inputFiles = []
  for (let index = 1; index <= 10; index += 1) {
    const label = String(index).padStart(2, '0')
    const file = path.join(temporaryInputDir, prefix + ' ' + label + '.pdf')
    await writeFile(
      file,
      Buffer.concat([
        sourceBytes,
        Buffer.from('\n% ' + prefix + ' unique-copy-' + label + '\n', 'utf8'),
      ]),
    )
    inputFiles.push(file)
  }

  const input = page.locator('.dpr-docPane input[type=file]').first()
  await input.setInputFiles(inputFiles)
  await page
    .locator('.dpr-docNotice')
    .filter({ hasText: '新入库 10 篇' })
    .waitFor({ state: 'visible', timeout: 120000 })
  await page.waitForTimeout(800)

  let managed = await managedLibrary()
  const imported = managed.items.filter((item) => String(item.originalName || '').startsWith(prefix))
  testJobIds.push(...imported.map((item) => item.jobId))
  if (imported.length !== 10) errors.push('批量导入后只找到 ' + imported.length + ' / 10 篇测试文档')
  if (imported.some((item) => item.status !== 'imported')) {
    errors.push('轻量导入后出现非 imported 状态：' + JSON.stringify(imported.map((item) => item.status)))
  }
  if ((await page.locator('.dpr-docRow').count()) < 10) {
    errors.push('管理页没有渲染 10 篇批量导入文档')
  }
  await screenshot('library-imported-10.png')

  await input.setInputFiles([inputFiles[0]])
  await page
    .locator('.dpr-docNotice')
    .filter({ hasText: '重复文件 1 篇' })
    .waitFor({ state: 'visible', timeout: 30000 })
  const afterDuplicate = await managedLibrary()
  const duplicateTestItems = afterDuplicate.items.filter((item) =>
    String(item.originalName || '').startsWith(prefix),
  )
  if (duplicateTestItems.length !== 10) {
    errors.push('重复哈希导入后测试文档数不是 10：' + duplicateTestItems.length)
  }

  const convertTarget = imported[0]
  const row = page.locator('.dpr-docRow[data-job-id="' + convertTarget.jobId + '"]')
  await row.waitFor({ state: 'visible', timeout: 20000 })
  await row.getByRole('button', { name: '开始转义', exact: true }).click()
  await page
    .locator('.dpr-docNotice')
    .filter({ hasText: '已排队 1 篇文档' })
    .waitFor({ state: 'visible', timeout: 30000 })
  const readyStatus = await waitReady(convertTarget.jobId)
  if (readyStatus.libraryStatus !== 'ready') errors.push('按需转义未达到 ready')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForTimeout(900)
  const readyRow = page.locator('.dpr-docRow[data-job-id="' + convertTarget.jobId + '"]')
  await readyRow.getByText('可阅读', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
  await screenshot('library-one-ready.png')

  const trashTarget = imported[1]
  const trashRow = page.locator('.dpr-docRow[data-job-id="' + trashTarget.jobId + '"]')
  page.once('dialog', (dialog) => void dialog.accept())
  await trashRow.getByRole('button', { name: '移到回收站', exact: true }).click()
  await page
    .locator('.dpr-docNotice')
    .filter({ hasText: '已移到回收站 1 篇' })
    .waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: /^回收站 \(/ }).click()
  const trashedRow = page.locator('.dpr-docRow[data-job-id="' + trashTarget.jobId + '"]')
  await trashedRow.waitFor({ state: 'visible', timeout: 20000 })
  await screenshot('library-trash.png')
  await trashedRow.getByRole('button', { name: '恢复', exact: true }).click()
  await page
    .locator('.dpr-docNotice')
    .filter({ hasText: '已恢复 1 篇文档' })
    .waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '返回文档库', exact: true }).click()
  await page.locator('.dpr-docRow[data-job-id="' + trashTarget.jobId + '"]').waitFor({
    state: 'visible',
    timeout: 20000,
  })

  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(500)
  const narrow = await page.evaluate(() => {
    const pane = document.querySelector('.dpr-docPane')
    return {
      clientWidth: pane?.clientWidth || 0,
      scrollWidth: pane?.scrollWidth || 0,
      viewport: window.innerWidth,
    }
  })
  if (narrow.scrollWidth > narrow.clientWidth + 1) {
    errors.push('375px 文档管理页出现横向溢出：' + JSON.stringify(narrow))
  }
  await screenshot('library-375.png')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(500)
  await screenshot('library-dark.png')
  await page.emulateMedia({ colorScheme: null })

  const openReadyRow = page.locator('.dpr-docRow[data-job-id="' + convertTarget.jobId + '"]')
  await openReadyRow.getByRole('button', { name: '打开阅读', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  await screenshot('library-open-ready-reader.png')

  const finalManaged = await managedLibrary()
  const finalTests = finalManaged.items.filter((item) =>
    testJobIds.includes(item.jobId),
  )
  if (finalTests.length !== 10) {
    errors.push('刷新后测试文档数量不是 10：' + finalTests.length)
  }
} catch (error) {
  errors.push(String(error?.stack || error))
  await screenshot('library-failure.png').catch(() => {})
} finally {
  if (temporaryInputDir) await rm(temporaryInputDir, { recursive: true, force: true }).catch(() => {})
  const report = {
    generatedAt: new Date().toISOString(),
    outDir,
    sourcePdf,
    testJobIds,
    screenshots,
    errors,
    keptForRestart: Boolean(args.keep),
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  if (!args.keep) {
    await cleanupReport(path.join(outDir, 'report.json')).catch((error) => {
      errors.push('清理失败：' + String(error))
    })
  }
  await browser.close()
  if (errors.length > 0) process.exitCode = 1
}
