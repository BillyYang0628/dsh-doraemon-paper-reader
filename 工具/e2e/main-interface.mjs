#!/usr/bin/env node
// L2（浏览器半区）：用真实浏览器打开一个已经在跑的 DSH dev 实例，走到「论文阅读器」主界面，
// 用**数值断言**验并排布局与关键文案，并出截图（亮/暗两套）。
//
// 用法（参数优先，其次环境变量，最后报错——不写死端口、会话 id、路径）：
//
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/main-interface.mjs --url "http://127.0.0.1:3105/?token=…" [--out 工具/gen/<主题>-<日期>]
//        [--mode dump|run|art] [--keep-open] [--headless]
//
// 说明：
// - 用系统已有的 Edge（`channel: 'msedge'`），**不下载 Playwright 浏览器内核**；
// - `--mode dump` 只打印页面上的按钮与文本，用来核对选择器，不做断言；
// - `--mode art` 把主形象插画放大到 2 倍再截图（看画风与边缘细节）；
// - 默认 headed：窗口留在主界面，方便人看（`--keep-open` 时脚本会一直挂着直到被中断）。

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { mode: 'run', headless: false, keepOpen: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') out.url = argv[++i]
    else if (token === '--out') out.out = argv[++i]
    else if (token === '--profile') out.profile = argv[++i]
    else if (token === '--mode') out.mode = argv[++i]
    else if (token === '--keep-open') out.keepOpen = true
    else if (token === '--headless') out.headless = true
    else throw new Error('未知参数：' + token)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url（dev 实例打印出来的带 token 地址）')

// 主界面文案（我们自己的产品文案；改文案时这里一起改——L0 已经断言过字典里的值）
const EXPECTED_QUESTION = '陛下要小的我如何取来论文'
const EXPECTED_SUB = '小的我更推荐 PDF 途径哦，陛下~'

const playwrightEntry = process.env.DPR_PLAYWRIGHT ?? 'playwright-core'
const { chromium } = require(playwrightEntry)

const profileDir = path.resolve(args.profile ?? '工具/gen/_e2e-profile')
const outDir = path.resolve(args.out ?? '工具/gen/e2e-open-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))

const consoleErrors = []

/** 一行摘要：把元素属性和盒模型压成便于比对的一行。 */
async function describe(page, selector, limit) {
  return page.evaluate(
    ({ selector, limit }) =>
      [...document.querySelectorAll(selector)].slice(0, limit).map((el, index) => {
        const rect = el.getBoundingClientRect()
        return {
          index,
          tag: el.tagName.toLowerCase(),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48),
          visible: rect.width > 0 && rect.height > 0,
          box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        }
      }),
    { selector, limit },
  )
}

/** 等主界面出现：等的是结构（问题那一行），不是具体文案。 */
async function waitForHome(page) {
  await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 20000 })
}

/** 可见就点（不可见/不存在返回 false），避免"点了反而把面板收起来"这类反效果。 */
async function clickIfVisible(page, name, timeout = 800) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click({ timeout })
  return true
}

/**
 * 走到主界面：展开右栏（若收着）→ 加号开引导页 → 点「论文阅读器」。
 * 引导页胶囊没出现时（右栏 tabs 属于会话，hero 画面下可能还没有停靠面），建一个**空**会话再试一次——
 * 建空会话不触发任何模型调用。
 * @param {object} page - Playwright 页面。
 * @returns {Promise<string[]>} 走成功的步骤（顺带当调试线索）。
 */
async function openMainInterface(page) {
  const steps = []
  if (await clickIfVisible(page, '打开右侧边栏')) {
    steps.push('展开右侧栏')
    await page.waitForTimeout(500)
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await clickIfVisible(page, '新标签页')) {
      steps.push('打开引导页')
      await page.waitForTimeout(700)
    }
    const entry = page.getByRole('button', { name: '论文阅读器' })
    if ((await entry.count()) > 0) {
      await entry.last().click()
      steps.push('点开「论文阅读器」入口')
      break
    }
    if (attempt === 0 && (await clickIfVisible(page, '新建会话'))) {
      steps.push('新建一个空会话')
      await page.waitForTimeout(1600)
    }
  }
  await waitForHome(page)
  return steps
}

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: args.headless,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

await page.goto(args.url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

if (args.mode === 'dump') {
  console.log('=== buttons')
  console.table(await describe(page, 'button', 80))
  console.log('=== 文本片段')
  console.log((await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 2500))
  await context.close()
  process.exit(0)
}

/** 出错时把现场倒出来（按钮 + 文本），省得靠猜。 */
async function dumpState() {
  console.log('=== 现场：buttons')
  console.table(await describe(page, 'button', 80))
  console.log('=== 现场：文本片段')
  console.log((await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 2000))
}

let steps
try {
  steps = await openMainInterface(page)
} catch (error) {
  console.log('走到主界面失败：' + error.message)
  await dumpState()
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, 'failed.png')
  await page.screenshot({ path: file }).catch(() => {})
  console.log('现场截图：' + file)
  await context.close()
  process.exit(1)
}
const pane = page.locator('.dpr-pane').first()
await pane.waitFor({ state: 'visible', timeout: 10000 })
await page.evaluate(async () => {
  await document.fonts?.ready
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
})
await page.waitForTimeout(250)

// --mode art：把主界面上的插画临时放大到 2 倍截图（只改页面样式，不动仓库里的资产）。
if (args.mode === 'art') {
  await mkdir(outDir, { recursive: true })
  await page.evaluate(() => {
    for (const image of document.querySelectorAll('.dpr-mascot')) {
      image.style.width = '336px'
      image.style.height = '336px'
    }
  })
  await page.waitForTimeout(300)
  const file = path.join(outDir, 'mascot-zoom.png')
  await page.locator('.dpr-mascot').first().screenshot({ path: file })
  console.log('放大预览：' + file)
  await context.close()
  process.exit(0)
}

// —— 数值断言（AGENTS.md K5：能数字化的别靠眼睛）——
const question = page.locator('.dpr-pane .dpr-question').first()
const subline = page.locator('.dpr-pane .dpr-sub').first()
const cards = [page.getByText('PDF 文件', { exact: true }).first(), page.getByText('信息查询', { exact: true }).first()]
const questionBox = await question.boundingBox()
const cardBoxes = []
for (const card of cards) cardBoxes.push(await card.boundingBox())

const findings = []
if (!questionBox || !cardBoxes.every(Boolean)) findings.push('关键文案或入口没有渲染出来（拿到空盒模型）')
const questionText = (await question.innerText()).trim()
if (questionText !== EXPECTED_QUESTION) findings.push('问题文案不符：' + JSON.stringify(questionText))
const subText = (await subline.innerText()).trim()
if (subText !== EXPECTED_SUB) findings.push('小字文案不符：' + JSON.stringify(subText))
if (questionBox && cardBoxes[0]) {
  if (!(questionBox.y < cardBoxes[0].y)) findings.push('问题没有排在入口之上')
  const heroCopyBox = await page.locator('.dpr-homeHero .dpr-heroCopy').boundingBox()
  const mascotStickerBox = await page.locator('.dpr-homeHero .dpr-mascotSticker').boundingBox()
  console.log(
    'Hero 盒模型：' +
      JSON.stringify({
        hero: await page.locator('.dpr-homeHero').boundingBox(),
        copy: heroCopyBox,
        sticker: mascotStickerBox,
        question: questionBox,
      }),
  )
  if (!heroCopyBox || !mascotStickerBox) {
    findings.push('非对称 Hero 的文案栏或插画栏缺失')
  } else {
    if (!(mascotStickerBox.x > heroCopyBox.x + heroCopyBox.width - 1)) {
      findings.push('Hero 文案与插画栏重叠')
    }
    if (Math.abs(heroCopyBox.y + heroCopyBox.height / 2 - (mascotStickerBox.y + mascotStickerBox.height / 2)) > 20) {
      findings.push('Hero 文案与插画没有垂直对齐')
    }
  }
}
if (cardBoxes[0] && cardBoxes[1]) {
  if (Math.abs(cardBoxes[0].y - cardBoxes[1].y) > 2) findings.push('两条入口不在同一行（没有并排）')
  if (!(cardBoxes[1].x > cardBoxes[0].x + cardBoxes[0].width - 1)) findings.push('两条入口在水平方向重叠')
}
const mascot = page.locator('.dpr-pane img.dpr-mascot').first()
if ((await mascot.count()) === 0) {
  findings.push('吉祥物插画（img.dpr-mascot）没出现')
} else {
  // 插画是宿主自注册路由发出来的：真加载成功才算这一环通了（naturalWidth 由浏览器填）
  const loaded = await mascot.evaluate((element) => ({
    complete: element.complete,
    width: element.naturalWidth,
    src: element.getAttribute('src'),
    alt: element.getAttribute('alt'),
  }))
  if (!loaded.complete || loaded.width === 0) findings.push('插画没加载出来：' + JSON.stringify(loaded))
  if (!loaded.alt) findings.push('插画缺少 alt')
  console.log('插画（宿主资源路由）：' + JSON.stringify(loaded))
}

await mkdir(outDir, { recursive: true })
const shots = []
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForTimeout(300)
  const palette = await page.locator('.dpr-pane').first().evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      base: style.getPropertyValue('--dpr-surface-base').trim(),
      raised: style.getPropertyValue('--dpr-surface-raised').trim(),
      soft: style.getPropertyValue('--dpr-surface-soft').trim(),
      brand: style.getPropertyValue('--dpr-brand').trim(),
      ink: style.getPropertyValue('--dpr-ink').trim(),
      warn: style.getPropertyValue('--dpr-warn').trim(),
      link: style.getPropertyValue('--dpr-link').trim(),
      hostBase: style.getPropertyValue('--dpr-host-base').trim(),
    }
  })
  console.log('主题 token（' + scheme + '）：' + JSON.stringify(palette))
  const file = path.join(outDir, 'main-interface-' + scheme + '.png')
  await pane.screenshot({ path: file })
  shots.push(file)
}
await page.emulateMedia({ colorScheme: null })

// —— 交互：点第一张入口 → 路径页 → 回主界面（验 openTab / replaceTab 真的通）——
const firstCard = page.locator('.dpr-pane .dpr-card').first()
await firstCard.click()
await page.locator('.dpr-pane .dpr-todoItem').first().waitFor({ state: 'visible', timeout: 10000 })
const pathHeading = (await page.locator('.dpr-pane .dpr-question').first().innerText()).trim()
if (pathHeading === EXPECTED_QUESTION) findings.push('点了入口没有切到路径页')
const pathItems = await page.locator('.dpr-pane .dpr-todoItem').count()
if (pathItems !== 3) findings.push('路径页「打算做什么」条目数不是 3：' + pathItems)
const fileInput = page.locator('.dpr-pane input[type=file]')
if ((await fileInput.count()) !== 1) findings.push('PDF 入口没有文件选择 input')
else {
  const accept = await fileInput.getAttribute('accept')
  if (!String(accept).includes('application/pdf')) findings.push('文件选择没有限制 PDF：' + accept)
}
if ((await page.getByRole('button', { name: '大肥鱼给朕速速抄写！！！', exact: true }).count()) !== 1) {
  findings.push('缺少「大肥鱼给朕速速抄写！！！」按钮')
}
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(300)
const pathShot = path.join(outDir, 'file-import-light.png')
await pane.screenshot({ path: pathShot })
const pathDarkShot = path.join(outDir, 'file-import-dark.png')
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(300)
await pane.screenshot({ path: pathDarkShot })
await page.emulateMedia({ colorScheme: null })

const importHeroBox = await page.locator('.dpr-importHero').boundingBox()
const importCopyBox = await page.locator('.dpr-importHeroCopy').boundingBox()
const importMascotBox = await page.locator('.dpr-importMascot .dpr-mascot').boundingBox()
const stepperBox = await page.locator('.dpr-stepper').boundingBox()
if (!importHeroBox || !importCopyBox || !importMascotBox || !stepperBox) {
  findings.push('PDF 文件页 Hero、插画或步骤条没有渲染')
} else {
  const visualGap = importMascotBox.x - (importCopyBox.x + importCopyBox.width)
  const belowGap = stepperBox.y - (importHeroBox.y + importHeroBox.height)
  if (importMascotBox.width < 90 || importMascotBox.height < 90) {
    findings.push('PDF 文件页大肥鱼仍然过小：' + JSON.stringify(importMascotBox))
  }
  if (visualGap < 12) findings.push('PDF 文件页插画与标题过近：' + visualGap)
  if (belowGap < 20) findings.push('PDF 文件页步骤图标没有与 Hero 拉开：' + belowGap)
  console.log(
    'PDF Hero：' +
      JSON.stringify({ hero: importHeroBox, copy: importCopyBox, mascot: importMascotBox, stepper: stepperBox, visualGap, belowGap }),
  )
}

await page.setViewportSize({ width: 375, height: 900 })
await page.waitForTimeout(150)
const narrowMascotBox = await page.locator('.dpr-importMascot .dpr-mascot').boundingBox()
const narrowSizes = await page.evaluate(() => ({
  rootClient: document.documentElement.clientWidth,
  rootScroll: document.documentElement.scrollWidth,
}))
if (!narrowMascotBox || narrowMascotBox.width > 82) {
  findings.push('PDF 文件页 375px 插画没有按断点缩小：' + JSON.stringify(narrowMascotBox))
}
if (narrowSizes.rootScroll > narrowSizes.rootClient + 1) {
  findings.push('PDF 文件页 375px 出现横向溢出：' + JSON.stringify(narrowSizes))
}
await pane.screenshot({ path: path.join(outDir, 'file-import-375.png') })
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(100)

await page.locator('.dpr-pane .dpr-back').first().click()
await page.locator('.dpr-pane .dpr-question').first().waitFor({ state: 'visible', timeout: 10000 })
const backHeading = (await page.locator('.dpr-pane .dpr-question').first().innerText()).trim()
if (backHeading !== EXPECTED_QUESTION) findings.push('「回到主界面」之后没回到主界面：' + JSON.stringify(backHeading))

console.log('走的步骤：' + steps.join(' → '))
console.log('问题盒模型：' + JSON.stringify(questionBox))
console.log('入口盒模型：' + JSON.stringify(cardBoxes))
console.log('截图：' + shots.join(' | '))
console.log('路径页：' + pathHeading + '（条目 ' + pathItems + ' 条）→ 截图 ' + pathShot + ' | ' + pathDarkShot)
console.log('页面 console error：' + (consoleErrors.length === 0 ? '无' : consoleErrors.join(' || ')))
console.log(findings.length === 0 ? '结论：主界面断言全通过' : '结论：不通过 → ' + findings.join('；'))

if (findings.length > 0) process.exitCode = 1

if (args.keepOpen) {
  console.log('窗口留在主界面，脚本挂起中（中断即关闭浏览器）')
  for await (const _ of process.stdin) void _ // eslint-disable-line no-unused-vars
} else {
  await context.close()
}
