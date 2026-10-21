#!/usr/bin/env node
// L2：阅读器选区浮层跟随 + 段落节奏 + 章节顺序。
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/selection-follow.mjs --url "http://127.0.0.1:3116/?token=…" --title "Sharing Detailed"

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--title') out.title = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--headed') out.headless = false
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url')
const outDir = path.resolve(args.out ?? '工具/gen/selection-follow-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const errors = []
const context = await chromium.launchPersistentContext(path.resolve('工具/gen/_e2e-selection-profile'), {
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

async function clickIfVisible(name, timeout = 900) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (!(await target.isVisible().catch(() => false))) return false
  await target.click({ timeout })
  return true
}

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
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
  await page.locator('.dpr-libraryItem').first().waitFor({ state: 'visible', timeout: 20000 })
  const item = args.title
    ? page.locator('.dpr-libraryItem', { hasText: args.title }).first()
    : page.locator('.dpr-libraryItem').first()
  await item.click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)

  const headings = await page.locator('.dpr-readerH .dpr-readerText').allInnerTexts()
  const refIndex = headings.findIndex((text) => /^REFERENCES$/i.test(text.trim()))
  const ackIndex = headings.findIndex((text) => /^ACKNOWLEDGMENTS$/i.test(text.trim()))
  const supportIndex = headings.findIndex((text) => /^SUPPORTING INFORMATION$/i.test(text.trim()))
  if (refIndex < 0 || ackIndex < 0) errors.push('缺少 REFERENCES / ACKNOWLEDGMENTS：' + JSON.stringify(headings))
  if (supportIndex < 0 || supportIndex > refIndex) errors.push('SUPPORTING INFORMATION 不在 REFERENCES 之前：' + JSON.stringify(headings))
  if (ackIndex < refIndex) errors.push('ACKNOWLEDGMENTS 仍在 REFERENCES 之前：' + JSON.stringify(headings))
  if (headings.slice(ackIndex + 1).some((text) => /^\d+\./.test(text))) {
    errors.push('ACKNOWLEDGMENTS 之后仍有参考文献：' + JSON.stringify(headings))
  }
  await mkdir(outDir, { recursive: true })
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('.dpr-readerH')]
      .find((element) => /^REFERENCES$/i.test((element.querySelector('.dpr-readerText')?.textContent || '').trim()))
    const scroller = target?.closest('.dpr-reader')
    if (scroller && target) scroller.scrollTop += target.getBoundingClientRect().top - 60
  })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(outDir, 'reader-backmatter.png') })
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('.dpr-readerH')]
      .find((element) => /^ACKNOWLEDGMENTS$/i.test((element.querySelector('.dpr-readerText')?.textContent || '').trim()))
    const scroller = target?.closest('.dpr-reader')
    if (scroller && target) scroller.scrollTop += target.getBoundingClientRect().top - 80
  })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(outDir, 'reader-acknowledgments.png') })

  const paragraphStyles = await page.evaluate(() =>
    [...document.querySelectorAll('.dpr-readerBody .dpr-readerP')]
      .filter((element) => !element.closest('.dpr-readerAbstract'))
      .map((element) => {
      const style = getComputedStyle(element)
      return {
        id: element.dataset.blockId,
        indent: style.textIndent,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        leading: (element.textContent || '').slice(0, 1),
      }
    }),
  )
  const badStyles = paragraphStyles.filter((item) =>
    item.indent !== '0px' || item.marginTop !== '0px' || item.marginBottom !== '13px' || /^\s/.test(item.leading),
  )
  if (badStyles.length) errors.push('段落首行/间距不一致：' + JSON.stringify(badStyles.slice(0, 6)))

  const measure = () => page.evaluate(() => {
    const selection = window.getSelection()
    const bar = document.querySelector('.dpr-selectionBar')
    if (!selection?.rangeCount || !bar) return null
    const anchor = selection.getRangeAt(0).getBoundingClientRect()
    const rect = bar.getBoundingClientRect()
    return {
      anchor: { top: anchor.top, bottom: anchor.bottom },
      bar: { top: rect.top, bottom: rect.bottom, height: rect.height },
    }
  })

  const clearSelection = async () => {
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges()
      document.querySelector('.dpr-reader')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.waitForTimeout(120)
  }

  const runScenario = async (label, paragraphIndex, nearTop = null) => {
    await clearSelection()
    const selected = await page.evaluate(({ index, alignTop }) => {
      const paragraphs = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP')]
        .filter((element) => !element.closest('.dpr-readerAbstract'))
      const target = paragraphs[index]
      if (!target) return false
      target.scrollIntoView({ block: 'center' })
      if (alignTop !== null) {
        const scroller = target.closest('.dpr-reader')
        const rect = target.getBoundingClientRect()
        if (scroller) scroller.scrollTop += rect.top - alignTop
      }
      const text = target.querySelector('.dpr-readerText')
      if (!text) return false
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      if (!node) return false
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(90, node.textContent.length))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    }, { index: paragraphIndex, alignTop: nearTop })
    if (!selected) {
      errors.push(label + '：没有可选中的正文段落')
      return null
    }
    await page.waitForTimeout(220)
    const initial = await measure()
    if (!initial) {
      errors.push(label + '：选区浮层未出现')
      return null
    }
    const side = initial.bar.top < initial.anchor.top ? 'above' : 'below'
    const viewTop = await page.evaluate(() => {
      const toolbar = document.querySelector('.dpr-readerBar')
      const reader = document.querySelector('.dpr-reader')
      return (toolbar ? toolbar.getBoundingClientRect().bottom : (reader?.getBoundingClientRect().top || 0)) + 8
    })
    const maxScroll = await page.evaluate(() => {
      const node = window.getSelection()?.anchorNode
      const element = node?.nodeType === 3 ? node.parentElement : node
      const scroller = element?.closest?.('.dpr-reader')
      return scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
    })
    const anchorDoc = await page.evaluate(() => {
      const selection = window.getSelection()
      const node = selection?.anchorNode
      const element = node?.nodeType === 3 ? node.parentElement : node
      const scroller = element?.closest?.('.dpr-reader')
      if (!scroller || !selection?.rangeCount) return 0
      return scroller.scrollTop + selection.getRangeAt(0).getBoundingClientRect().top
    })
    const focus = [-900, -700, -500, -350, -200, -80, 0, 120, 300, 600].map((offset) => anchorDoc + offset)
    const targets = [
      ...focus,
      ...[0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 0.8, 0.55, 0.35, 0.15, 0].map((ratio) => Math.round(maxScroll * ratio)),
    ]
      .map((value) => Math.max(0, Math.min(maxScroll, Math.round(value))))
      .filter((value, index, list) => list.indexOf(value) === index)
    const samples = []
    for (const target of targets) {
      await page.evaluate((value) => {
        const node = window.getSelection()?.anchorNode
        const element = node?.nodeType === 3 ? node.parentElement : node
        const scroller = element?.closest?.('.dpr-reader')
        if (scroller) scroller.scrollTop = value
      }, target)
      await page.waitForTimeout(60)
      const measured = await measure()
      if (!measured) {
        errors.push(label + '：滚动 ' + target + ' 后选区或浮层消失')
        continue
      }
      const raw = side === 'above'
        ? measured.anchor.top - 8 - measured.bar.height
        : measured.anchor.bottom + 8
      const clamped = Math.max(viewTop, Math.min(988 - measured.bar.height, raw))
      samples.push({ target, raw, clamped, measured })
      if (Math.abs(measured.bar.top - clamped) > 2) {
        errors.push(label + '：滚动 ' + target + ' 浮层位置错误：' + JSON.stringify({ side, raw, clamped, measured }))
      }
      if (measured.bar.top < 55 || measured.bar.bottom > 989) {
        errors.push(label + '：滚动 ' + target + ' 浮层出界：' + JSON.stringify(measured))
      }
    }
    const relative = samples
      .filter((sample) => Math.abs(sample.raw - sample.clamped) < 0.01)
      .map((sample) => side === 'above'
        ? sample.measured.anchor.top - sample.measured.bar.bottom
        : sample.measured.bar.top - sample.measured.anchor.bottom)
    if (relative.some((gap) => Math.abs(gap - 8) > 1.5)) {
      errors.push(label + '：浮层与选区的相对距离不恒定：' + JSON.stringify(relative))
    }
    const offscreen = samples.filter((sample) => sample.measured.anchor.bottom < viewTop || sample.measured.anchor.top > 1000)
    for (const sample of offscreen) {
      const atEdge = sample.measured.anchor.bottom < viewTop
        ? Math.abs(sample.measured.bar.top - viewTop) <= 2
        : Math.abs(sample.measured.bar.bottom - 988) <= 2
      if (!atEdge) errors.push(label + '：选区离屏后浮层未停边界：' + JSON.stringify(sample))
    }

    // 文本框高度变化时，浮层应贴着同一侧改变自身高度，而不是漂移。
    await page.evaluate(() => {
      const selection = window.getSelection()
      const node = selection?.anchorNode
      const element = node?.nodeType === 3 ? node.parentElement : node
      const scroller = element?.closest?.('.dpr-reader')
      if (!scroller || !selection?.rangeCount) return
      scroller.scrollTop = Math.max(0, scroller.scrollTop + selection.getRangeAt(0).getBoundingClientRect().top - 420)
    })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const textarea = document.querySelector('.dpr-selectionBar textarea')
      if (textarea) textarea.style.height = '110px'
    })
    await page.waitForTimeout(120)
    const resized = await measure()
    if (resized) {
      const gap = side === 'above'
        ? resized.anchor.top - resized.bar.bottom
        : resized.bar.top - resized.anchor.bottom
      if (Math.abs(gap - 8) > 2) {
        errors.push(label + '：文本框变高后浮层漂移：' + JSON.stringify({ side, gap, resized }))
      }
    }
    return { label, side, relative, samples: samples.length, offscreen: offscreen.length }
  }

  const bodyParagraphCount = await page.evaluate(
    () => [...document.querySelectorAll('.dpr-readerBody .dpr-readerP')]
      .filter((element) => !element.closest('.dpr-readerAbstract')).length,
  )
  const scenarios = []
  for (const [label, index] of [
    ['first', 0],
    ['middle', Math.floor(bodyParagraphCount / 2)],
    ['last', bodyParagraphCount - 1],
  ]) {
    scenarios.push(await runScenario(label, index))
  }
  scenarios.push(await runScenario('top-edge', 0, 95))

  // 让选区滚到视口上方：浮层必须停在标题栏横线以下，而不是压住标题。
  await clearSelection()
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP')]
      .filter((element) => !element.closest('.dpr-readerAbstract'))[0]
    if (!paragraph) return
    paragraph.scrollIntoView({ block: 'center' })
    const text = paragraph.querySelector('.dpr-readerText')
    if (!text) return
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode()
    if (!node) return
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(90, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForTimeout(220)
  await page.evaluate(() => {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node?.nodeType === 3 ? node.parentElement : node
    const scroller = element?.closest?.('.dpr-reader')
    if (!scroller || !selection?.rangeCount) return
    scroller.scrollTop += selection.getRangeAt(0).getBoundingClientRect().top + 900
  })
  await page.waitForTimeout(180)
  const topClamp = await page.evaluate(() => {
    const toolbar = document.querySelector('.dpr-readerBar')
    const bar = document.querySelector('.dpr-selectionBar')
    if (!toolbar || !bar) return null
    const toolbarRect = toolbar.getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    return { toolbarBottom: toolbarRect.bottom, barTop: barRect.top, barBottom: barRect.bottom }
  })
  if (topClamp) {
    if (Math.abs(topClamp.barTop - (topClamp.toolbarBottom + 8)) > 2) {
      errors.push('顶部夹取没有停在标题栏横线下方：' + JSON.stringify(topClamp))
    }
    if (topClamp.barTop < topClamp.toolbarBottom + 2) {
      errors.push('顶部夹取压住了标题栏：' + JSON.stringify(topClamp))
    }
  }
  await page.screenshot({ path: path.join(outDir, 'reader-top-clamp.png') })

  await page.screenshot({ path: path.join(outDir, 'reader-selection.png') })
  console.log(JSON.stringify({
    out: outDir,
    headings,
    paragraphCount: paragraphStyles.length,
    scenarios,
    topClamp,
    errors,
  }, null, 2))
  if (errors.length) process.exitCode = 1
} finally {
  await context.close()
}
