#!/usr/bin/env node
// L2：透明插画在真实 DSH 页面里的状态、资源、动效降级与窄屏检查。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/illustration-states.mjs --url "http://127.0.0.1:3115/?token=…" --job <已完成 jobId>
//
// 本脚本不改业务数据；只有“失败态”会通过浏览器拖入一个极小 PDF，让真实导入管线自然失败。
// 脚本会输出该临时 jobId，跑完应把它从 jobs/ 清掉。

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--job') out.job = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--profile') out.profile = argv[++i]
    else if (argv[i] === '--headed') out.headless = false
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url || !args.job) throw new Error('必须给 --url 与 --job')

const outDir = path.resolve(
  args.out ?? '工具/gen/illustration-integration-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
)
const profileDir = path.resolve(args.profile ?? '工具/gen/_illustration-states-profile')
const errors = []
const findings = []
let allowControlledLookupFailure = false

await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
  reducedMotion: 'no-preference',
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    !(allowControlledLookupFailure && message.text().includes('503'))
  ) {
    errors.push(message.text())
  }
})
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
  if (
    response.status() >= 400 &&
    response.url().startsWith(args.url.split('/?')[0]) &&
    !(
      allowControlledLookupFailure &&
      response.url().includes('/doraemon-paper-reader/api/lookup/resolve')
    )
  ) {
    errors.push('HTTP ' + response.status() + ' ' + response.url())
  }
})

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click()
  return true
}

async function openMainInterface() {
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(400)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible('新标签页')) await page.waitForTimeout(600)
    const entry = page.getByRole('button', { name: '论文阅读器' }).last()
    if ((await entry.count()) > 0) {
      await entry.click()
      break
    }
    if (attempt === 0 && (await clickIfVisible('新建会话'))) await page.waitForTimeout(1400)
  }
  await page.locator('.dpr-pane .dpr-card').first().waitFor({ state: 'visible', timeout: 20000 })
}

async function openPdfTab() {
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page
    .locator('.dpr-pane input[type=file], .dpr-pane .dpr-load')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
}

async function imageState(selector) {
  const image = page.locator(selector).first()
  await image.waitFor({ state: 'visible', timeout: 15000 })
  return image.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      src: element.getAttribute('src'),
      complete: element.complete,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      padding: style.paddingTop,
      animationName: style.animationName,
      transform: style.transform,
    }
  })
}

async function assertNoHorizontalOverflow(label) {
  const sizes = await page.evaluate(() => ({
    rootClient: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth,
    paneClient: document.querySelector('.dpr-pane')?.clientWidth || 0,
    paneScroll: document.querySelector('.dpr-pane')?.scrollWidth || 0,
  }))
  if (sizes.rootScroll > sizes.rootClient + 1 || sizes.paneScroll > sizes.paneClient + 1) {
    findings.push(label + ' 出现横向溢出：' + JSON.stringify(sizes))
  }
}

async function assertLoadPanelsSeparated(label) {
  const boxes = await page.evaluate(() => {
    const slotEl = document.querySelector('.dpr-loadHero .dpr-mascotSlot')
    const slot = slotEl?.getBoundingClientRect()
    const copy = document.querySelector('.dpr-loadCopy')?.getBoundingClientRect()
    return slot && copy
      ? {
          slot: { left: slot.left, top: slot.top, right: slot.right, bottom: slot.bottom, width: slot.width, height: slot.height },
          copy: { left: copy.left, top: copy.top, right: copy.right, bottom: copy.bottom, width: copy.width },
          gap: copy.top - slot.bottom,
          background: getComputedStyle(slotEl).backgroundColor,
          borderWidth: getComputedStyle(slotEl).borderTopWidth,
          padding: getComputedStyle(slotEl).paddingTop,
          noteExists: Boolean(document.querySelector('.dpr-slotNote')),
        }
      : null
  })
  if (!boxes) {
    findings.push(label + ' 缺少加载页插画槽或文案栏')
  } else if (boxes.gap < 8) {
    findings.push(label + ' 插画与文案垂直间距不足：' + JSON.stringify(boxes))
  }
  if (boxes && boxes.noteExists) findings.push(label + ' 仍残留插画说明文字')
  if (boxes && (boxes.background !== 'rgba(0, 0, 0, 0)' || boxes.borderWidth !== '0px' || boxes.padding !== '0px')) {
    findings.push(label + ' 插画外层仍有残留卡面：' + JSON.stringify(boxes))
  }
}

let failedJobId = ''
try {
  await page.addInitScript((jobId) => {
    try {
      if (!window.sessionStorage.getItem('doraemonIllustrationStateSeeded')) {
        window.localStorage.setItem('doraemonPaperReader.lastJobId', jobId)
        window.sessionStorage.setItem('doraemonIllustrationStateSeeded', '1')
      }
    } catch {
      // localStorage may be unavailable in a locked-down profile.
    }
  }, args.job)

  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await openMainInterface()

  const home = await imageState('.dpr-homeHero img.dpr-mascot.is-transparent')
  if (!home.src?.endsWith('/home-open-book-transparent-v1.webp')) {
    findings.push('主界面没有使用捧书主形象：' + home.src)
  }
  if (!home.complete || home.naturalWidth === 0) findings.push('主界面透明插画未加载')
  if (home.background !== 'rgba(0, 0, 0, 0)' || home.borderWidth !== '0px' || home.padding !== '0px') {
    findings.push('主界面透明插画仍被旧卡面规则套底：' + JSON.stringify(home))
  }

  await openPdfTab()
  await page.locator('.dpr-load').waitFor({ state: 'visible', timeout: 20000 })

  // 用真实已完成的 job 检查成功精灵图。只读状态；不伪造本地论文。
  const doneSprite = page.locator('.dpr-mascotSprite--success').first()
  await doneSprite.waitFor({ state: 'visible', timeout: 20000 })
  await assertLoadPanelsSeparated('PDF 完成态')
  const doneFrameSize = await doneSprite.evaluate((element) => element.getBoundingClientRect().width)
  const doneEndTransform = 'matrix(1, 0, 0, 1, ' + -4 * doneFrameSize + ', 0)'
  const doneImage = await imageState('.dpr-mascotSprite--success img')
  if (doneImage.naturalWidth !== 1600 || doneImage.naturalHeight !== 320 || doneImage.width !== 1080 || doneImage.height !== 216) {
    findings.push('成功精灵图尺寸不对：' + JSON.stringify(doneImage))
  }
  await page.waitForTimeout(700)
  const doneMotion = await imageState('.dpr-mascotSprite--success img')
  if (doneMotion.transform !== doneEndTransform) {
    findings.push('成功动画没有停在完成帧：' + doneMotion.transform)
  }
  await page.screenshot({ path: path.join(outDir, 'pdf-done-wide.png'), fullPage: true })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(50)
  const doneReduced = await imageState('.dpr-mascotSprite--success img')
  if (doneReduced.animationName !== 'none' || doneReduced.transform !== doneEndTransform) {
    findings.push('减少动态时成功图没有直接显示完成帧：' + JSON.stringify(doneReduced))
  }
  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(120)
  await assertNoHorizontalOverflow('PDF 完成态 375px')
  await page.screenshot({ path: path.join(outDir, 'pdf-done-375-reduced.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // UI 状态注入：让真实页面按 running 分支渲染加载精灵图，只截视觉，不写盘。
  await clickIfVisible('回到主界面')
  await page.route('**/doraemon-paper-reader/api/jobs/' + args.job, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: args.job,
        status: 'running',
        stage: 'read',
        startedAt: new Date().toISOString(),
        originalName: 'illustration-state-check.pdf',
        message: '',
      }),
    }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await openMainInterface()
  await openPdfTab()
  const loadingSprite = page.locator('.dpr-mascotSprite--loading').first()
  await loadingSprite.waitFor({ state: 'visible', timeout: 15000 })
  await assertLoadPanelsSeparated('PDF 加载态')
  const loadingImage = await imageState('.dpr-mascotSprite--loading img')
  if (loadingImage.naturalWidth !== 1920 || loadingImage.naturalHeight !== 320 || loadingImage.width !== 1296 || loadingImage.height !== 216) {
    findings.push('加载精灵图尺寸不对：' + JSON.stringify(loadingImage))
  }
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, 'pdf-loading-frame.png'), fullPage: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(50)
  const loadingReduced = await imageState('.dpr-mascotSprite--loading img')
  if (
    loadingReduced.animationName !== 'none' ||
    loadingReduced.transform !== 'matrix(1, 0, 0, 1, 0, 0)'
  ) {
    findings.push('减少动态时加载图没有停在首帧：' + JSON.stringify(loadingReduced))
  }
  await page.screenshot({ path: path.join(outDir, 'pdf-loading-reduced.png'), fullPage: true })
  await page.unroute('**/doraemon-paper-reader/api/jobs/' + args.job)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // 真实失败态：极小但通过魔数检查的 PDF 会建 job，随后由管线自然失败。
  await page.evaluate(() => localStorage.removeItem('doraemonPaperReader.lastJobId'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await openMainInterface()
  await openPdfTab()
  const beforeJobId = await page.evaluate(() => localStorage.getItem('doraemonPaperReader.lastJobId'))
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new TextEncoder().encode('%PDF-1.4\n%%EOF\n')], 'illustration-failed.pdf', {
        type: 'application/pdf',
      }),
    )
    document
      .querySelector('.dpr-drop')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await page.getByRole('button', { name: '大肥鱼给朕速速抄写！！！', exact: true }).click()
  await page.locator('.dpr-load').waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('.dpr-load .dpr-error').waitFor({ state: 'visible', timeout: 60000 })
  failedJobId = await page.evaluate(() => localStorage.getItem('doraemonPaperReader.lastJobId'))
  if (!failedJobId || failedJobId === beforeJobId) findings.push('失败态没有生成可追踪的临时 jobId')
  const failed = await imageState('.dpr-load img.dpr-mascot.is-transparent')
  if (!failed.src?.endsWith('/error-play-dead-transparent-v1.webp') || failed.naturalWidth === 0) {
    findings.push('PDF 失败态没有显示装死插画：' + JSON.stringify(failed))
  }
  await page.screenshot({ path: path.join(outDir, 'pdf-failed.png'), fullPage: true })

  // 查询初始态：猎鹿帽 + 放大镜。
  await page.getByRole('button', { name: '回到主界面', exact: true }).click()
  await page.locator('.dpr-pane .dpr-card').nth(1).click()
  await page.locator('.dpr-lookup').waitFor({ state: 'visible', timeout: 15000 })
  const lookup = await imageState('.dpr-hero img.dpr-mascot.is-transparent')
  if (!lookup.src?.endsWith('/lookup-detective-transparent-v1.webp') || lookup.naturalWidth === 0) {
    findings.push('查询初始态没有显示侦探插画：' + JSON.stringify(lookup))
  }
  await page.screenshot({ path: path.join(outDir, 'lookup-initial.png'), fullPage: true })

  // 查询 error/none 两个结果态走可控响应，只验证展示层；真实 resolve 链由 lookup.mjs 覆盖。
  allowControlledLookupFailure = true
  for (const state of [
    { name: 'error', status: 503, payload: { error: 'controlled lookup failure' } },
    { name: 'none', status: 200, payload: { kind: 'none', message: '没有找到这篇论文。' } },
  ]) {
    await page.route('**/doraemon-paper-reader/api/lookup/resolve', (route) =>
      route.fulfill({
        status: state.status,
        contentType: 'application/json',
        body: JSON.stringify(state.payload),
      }),
    )
    await page.getByPlaceholder('10.3390/s22114003').fill('10.0000/controlled-state')
    await page.getByRole('button', { name: '去找论文', exact: true }).click()
    if (state.name === 'error') {
      await page.locator('.dpr-lookup .dpr-error').waitFor({ state: 'visible', timeout: 10000 })
    } else {
      await page.getByText('没有找到这篇论文。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    }
    const errorArt = await imageState('.dpr-hero img.dpr-mascot.is-transparent')
    if (!errorArt.src?.endsWith('/error-play-dead-transparent-v1.webp')) {
      findings.push('查询 ' + state.name + ' 没有显示装死插画：' + errorArt.src)
    }
    await page.screenshot({ path: path.join(outDir, 'lookup-' + state.name + '.png'), fullPage: true })
    await page.unroute('**/doraemon-paper-reader/api/lookup/resolve')
  }
  allowControlledLookupFailure = false

  await page.setViewportSize({ width: 375, height: 900 })
  await page.waitForTimeout(100)
  await assertNoHorizontalOverflow('查询错误态 375px')

  const report = {
    job: args.job,
    failedJobId,
    home,
    doneImage,
    doneMotion,
    doneReduced,
    loadingImage,
    loadingReduced,
    lookup,
    errors,
    findings,
    screenshots: [
      'pdf-done-wide.png',
      'pdf-done-375-reduced.png',
      'pdf-loading-frame.png',
      'pdf-loading-reduced.png',
      'pdf-failed.png',
      'lookup-initial.png',
      'lookup-error.png',
      'lookup-none.png',
    ],
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  if (errors.length > 0 || findings.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
