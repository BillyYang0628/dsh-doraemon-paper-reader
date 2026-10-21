#!/usr/bin/env node
// L2：对照工作台 v2（双论文全文 + 右侧工作台 + 产物浮窗）。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/compare.mjs --url "http://127.0.0.1:3117/?token=…" [--out <dir>] [--with-llm]
//
// 默认验布局/蓝链/批注/产物入口；--with-llm 才真的生成表格、工作台回答与引用判断。

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { headless: true, withLlm: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') out.url = argv[++i]
    else if (token === '--out') out.out = argv[++i]
    else if (token === '--profile') out.profile = argv[++i]
    else if (token === '--with-llm') out.withLlm = true
    else if (token === '--headed') out.headless = false
    else throw new Error('未知参数：' + token)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url（dev 实例打印出来的带 token 地址）')

const profileDir = path.resolve(args.profile ?? '工具/gen/_e2e-compare-profile')
const outDir = path.resolve(
  args.out ?? '工具/gen/compare-v2-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
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

async function shot(name, selector) {
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, name)
  const target = selector ? page.locator(selector).first() : page
  await target.screenshot({ path: file })
  return file
}

const closeArtifact = async () => {
  await page.locator('.dpr-cmpArtHead .dpr-compareClose').first().click()
  await page.waitForTimeout(250)
}

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await openMainInterface()

  const surveyCard = page.locator('.dpr-surveyCard').first()
  if (!(await surveyCard.isVisible().catch(() => false))) findings.push('主界面没有「多篇综述」入口')
  else await surveyCard.click()

  await page.locator('.dpr-surveyRow').first().waitFor({ state: 'visible', timeout: 10000 })
  const surveyRows = page.locator('.dpr-surveyRow')
  const preferredPapers = await page.evaluate(async () => {
    const library = await (await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })).json()
    const ranked = []
    for (const paper of Array.isArray(library.papers) ? library.papers : []) {
      try {
        const doc = await (
          await fetch(
            'doraemon-paper-reader/api/jobs/' + encodeURIComponent(paper.jobId) + '/mirrordoc.json',
            { cache: 'no-store' },
          )
        ).json()
        const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
        const paragraphs = blocks.filter((block) => block.type === 'paragraph').length
        const equations = blocks.filter((block) => block.type === 'equation').length
        const formulas = await (
          await fetch(
            'doraemon-paper-reader/api/jobs/' + encodeURIComponent(paper.jobId) + '/formulas',
            { cache: 'no-store' },
          )
        )
          .json()
          .catch(() => ({}))
        const validFormulas = Object.values(formulas?.blocks || {}).filter((block) => block?.valid).length
        ranked.push({
          jobId: paper.jobId,
          title: paper.title,
          paragraphs,
          equations,
          validFormulas,
        })
      } catch {
        // 残缺作业不参与自动选样。
      }
    }
    ranked.sort((a, b) => {
      const coverageA = Number(a.validFormulas > 0) + Number(a.equations > 0)
      const coverageB = Number(b.validFormulas > 0) + Number(b.equations > 0)
      return coverageB - coverageA || b.validFormulas - a.validFormulas || b.paragraphs - a.paragraphs
    })
    return ranked.filter((paper) => paper.paragraphs >= 20).slice(0, 2)
  })
  const pickTitle = async (text) => {
    const row = surveyRows.filter({ hasText: text }).first()
    if ((await row.count()) === 0) return false
    await row.locator('input[type=checkbox]').check()
    return true
  }
  const pickedA = preferredPapers[0] ? await pickTitle(preferredPapers[0].title) : false
  const pickedB = preferredPapers[1] ? await pickTitle(preferredPapers[1].title) : false
  if (!pickedA || !pickedB) {
    const boxes = page.locator('.dpr-surveyRow input[type=checkbox]')
    if ((await boxes.count()) < 2) throw new Error('论文库少于 2 篇')
    await boxes.nth(0).check()
    await boxes.nth(1).check()
  }
  await page.getByRole('button', { name: /开始对照/ }).first().click()

  await page.locator('.dpr-comparePanel').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-cmpPaperPane').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-cmpBlock').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(1200)
  await page.locator('.dpr-cmpKatex .katex').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})

  const paneCount = await page.locator('.dpr-cmpPaperPane').count()
  const blockCount = await page.locator('.dpr-cmpBlock').count()
  const linkCount = await page.locator('.dpr-cmpCiteLink').count()
  const latexCount = await page.locator('.dpr-cmpLatex').count()
  const formulaSvgCount = await page.locator('.dpr-cmpFormulaSvg').count()
  const katexCount = await page.locator('.dpr-cmpKatex .katex').count()
  if ((await page.getByRole('button', { name: '模拟引用（调试）', exact: true }).count()) === 0) {
    findings.push('综述工作台缺少模拟引用入口')
  }
  if ((await page.getByRole('button', { name: '导出报告', exact: true }).count()) === 0) {
    findings.push('工作台缺少导出报告入口')
  }
  if ((await page.getByRole('button', { name: '归档', exact: true }).count()) === 0) {
    findings.push('工作台缺少本地归档入口')
  }
  if ((await page.getByRole('button', { name: '数据图', exact: true }).count()) === 0) {
    findings.push('工作台缺少数据图入口')
  }
  if ((await page.getByRole('button', { name: '概念图', exact: true }).count()) === 0) {
    findings.push('工作台缺少概念图入口')
  }
  const leftBox = await page.locator('.dpr-cmpPapers').boundingBox()
  const rightBox = await page.locator('.dpr-cmpWorkspace').boundingBox()
  if (paneCount !== 2) findings.push('论文全文栏不是 2 个：' + paneCount)
  if (blockCount < 20) findings.push('全文块太少，可能没有渲染正文：' + blockCount)
  if (latexCount < 1) findings.push('公式 LaTeX 没有同步：' + latexCount)
  if (katexCount < 1 && formulaSvgCount < 1) {
    findings.push('公式既没有 KaTeX 也没有 SVG 渲染')
  }
  let formulaShot = ''
  if (katexCount > 0 || formulaSvgCount > 0) {
    const formulaTarget =
      katexCount > 0 ? page.locator('.dpr-cmpKatex').first() : page.locator('.dpr-cmpFormulaSvg').first()
    await formulaTarget.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    formulaShot = await shot(
      'compare-v2-formula.png',
      katexCount > 0 ? '.dpr-cmpKatex' : '.dpr-cmpFormulaSvg',
    )
  }
  if (!leftBox || !rightBox) findings.push('拿不到左右栏盒模型')
  if (leftBox && rightBox) {
    const ratio = leftBox.width / rightBox.width
    if (ratio < 2.3 || ratio > 3.1) findings.push('左右比例不在 8:3 附近：' + ratio.toFixed(2))
    if (rightBox.width < 330) findings.push('右侧工作台太窄：' + rightBox.width)
  }
  const layoutShot = await shot('compare-v2-layout.png', '.dpr-comparePanel')

  let tableRows = 0
  let anchors = 0
  let linePoints = 0
  let lineAnchors = 0
  if (args.withLlm) {
    await page.getByRole('button', { name: '生成对照表', exact: true }).first().click()
    await page.locator('.dpr-cmpArtWindow .dpr-compareTable').waitFor({ state: 'visible', timeout: 120000 })
    tableRows = await page.locator('.dpr-cmpArtWindow .dpr-compareTable tbody tr').count()
    anchors = await page.locator('.dpr-cmpArtWindow .dpr-compareAnchor').count()
    if (tableRows !== 7) findings.push('对照表不是 7 个字段行：' + tableRows)
    if (anchors === 0) findings.push('对照表没有可定位锚点')
    if ((await page.getByRole('button', { name: '复制 Markdown', exact: true }).count()) === 0) {
      findings.push('对照表没有 Markdown 导出按钮')
    }
    if ((await page.getByRole('button', { name: '编辑', exact: true }).count()) === 0) {
      findings.push('对照表没有人工编辑入口')
    }
    const beforeDrag = await page.locator('.dpr-cmpArtWindow').boundingBox()
    const headerBox = await page.locator('.dpr-cmpArtHead').first().boundingBox()
    if (beforeDrag && headerBox) {
      await page.mouse.move(headerBox.x + 50, headerBox.y + 8)
      await page.mouse.down()
      await page.mouse.move(headerBox.x + 110, headerBox.y + 58, { steps: 6 })
      await page.mouse.up()
      const afterDrag = await page.locator('.dpr-cmpArtWindow').boundingBox()
      if (!afterDrag || Math.abs(afterDrag.x - beforeDrag.x) < 8) {
        findings.push('产物浮窗不能拖动')
      }
    }
    await shot('compare-v2-table.png', '.dpr-cmpArtWindow')
    await closeArtifact()

    await page.getByRole('button', { name: '证据覆盖', exact: true }).first().click()
    await page.locator('.dpr-cmpArtWindow .dpr-cmpChartList').waitFor({ state: 'visible', timeout: 30000 })
    const coverageCards = await page.locator('.dpr-cmpArtWindow .dpr-cmpChartCard').count()
    if (coverageCards < 2) findings.push('覆盖度图没有两篇的覆盖统计：' + coverageCards)
    await shot('compare-v2-coverage.png', '.dpr-cmpArtWindow')
    await closeArtifact()

    await page.getByRole('button', { name: '数据图', exact: true }).first().click()
    const modelChart = page.locator('.dpr-cmpModelChart')
    const modelError = page.locator('.dpr-cmpTopError')
    await Promise.race([
      modelChart.waitFor({ state: 'visible', timeout: 90000 }),
      modelError.waitFor({ state: 'visible', timeout: 90000 }),
    ]).catch(() => {})
    if (await modelChart.isVisible().catch(() => false)) {
      const points = await page.locator('.dpr-cmpModelChart .dpr-cmpChartRow').count()
      if (points < 1) findings.push('模型图表没有有效数据点')
      await shot('compare-v2-model-chart.png', '.dpr-cmpArtWindow')
      await closeArtifact()
    } else {
      findings.push('数据图没有生成（模型未返回可核对数字）')
    }

    await page.getByRole('tab', { name: '对话', exact: true }).first().click()
    const lineComposer = page.locator('.dpr-cmpComposer textarea').first()
    await lineComposer.fill(
      '请只用已有的质粒全长数字画一张折线图，type 必须是 line，按 pIP1202、pSN254、pYR1 排列；不足三个点就返回空。',
    )
    await lineComposer.press('Enter')
    const lineChart = page.locator('.dpr-cmpLineChart')
    await Promise.race([
      lineChart.waitFor({ state: 'visible', timeout: 120000 }),
      page.locator('.dpr-cmpTopError').waitFor({ state: 'visible', timeout: 120000 }),
    ]).catch(() => {})
    if (await lineChart.isVisible().catch(() => false)) {
      linePoints = await page.locator('.dpr-cmpLineChart circle').count()
      lineAnchors = await page.locator('.dpr-cmpAnchors .dpr-compareAnchor').count()
      if (linePoints < 2) findings.push('折线数据点不足：' + linePoints)
      if (lineAnchors < 1) findings.push('折线图没有原文锚点')
      await shot('compare-v2-line-chart.png', '.dpr-cmpArtWindow')
      await closeArtifact()
    } else {
      findings.push('折线图没有生成（模型未按 line 返回可核对数字）')
    }

    await page.getByRole('button', { name: '概念图', exact: true }).first().click()
    const conceptGraph = page.locator('.dpr-cmpConcept')
    const conceptError = page.locator('.dpr-cmpTopError')
    await Promise.race([
      conceptGraph.waitFor({ state: 'visible', timeout: 120000 }),
      conceptError.waitFor({ state: 'visible', timeout: 120000 }),
    ]).catch(() => {})
    if (await conceptGraph.isVisible().catch(() => false)) {
      const conceptNodes = await page.locator('.dpr-cmpConceptNode').count()
      const conceptAnchors = await page.locator('.dpr-cmpConceptAnchors .dpr-compareAnchor').count()
      if (conceptNodes < 2) findings.push('概念图节点不足：' + conceptNodes)
      if (conceptAnchors < 1) findings.push('概念图没有原文锚点')
      await shot('compare-v2-concept.png', '.dpr-cmpArtWindow')
      await closeArtifact()
    } else {
      findings.push('概念图没有生成')
    }

    await page.getByRole('button', { name: '论证链', exact: true }).first().click()
    await page.locator('.dpr-cmpArtWindow .dpr-cmpLogicGrid').waitFor({ state: 'visible', timeout: 30000 })
    await shot('compare-v2-logic.png', '.dpr-cmpArtWindow')
    await closeArtifact()
  }

  await page.getByRole('button', { name: '结构统计', exact: true }).first().click()
  await page.locator('.dpr-cmpArtWindow .dpr-cmpChartList').waitFor({ state: 'visible', timeout: 10000 })
  const chartRows = await page.locator('.dpr-cmpArtWindow .dpr-cmpChartRow').count()
  if (chartRows < 6) findings.push('结构图数据行不足：' + chartRows)
  await shot('compare-v2-chart.png', '.dpr-cmpArtWindow')
  await closeArtifact()

  await page.locator('.dpr-cmpRailBtn').click()
  const artItems = await page.locator('.dpr-cmpArtItem').count()
  if (args.withLlm && artItems < 2) findings.push('产物列表条目不足：' + artItems)
  const artShot = await shot('compare-v2-artlist.png', '.dpr-cmpArtList')
  await page.locator('.dpr-cmpRailBtn').click()

  if (args.withLlm) {
    await page.locator('.dpr-cmpRailBtn').click()
    await page.locator('.dpr-cmpArtItem').filter({ hasText: '七字段对照表' }).click()
    await page.locator('.dpr-cmpArtWindow').first().waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('.dpr-cmpRailBtn').click()
    await page.locator('.dpr-cmpArtItem').filter({ hasText: '论证链对照' }).click()
    await page.locator('.dpr-cmpArtWindow').nth(1).waitFor({ state: 'visible', timeout: 10000 })
    const multiWindows = await page.locator('.dpr-cmpArtWindow').count()
    if (multiWindows < 2) findings.push('产物不能同时打开多个浮窗：' + multiWindows)
    await shot('compare-v2-multi.png', '.dpr-comparePanel')
    while ((await page.locator('.dpr-cmpArtHead .dpr-compareClose').count()) > 0) {
      await page.locator('.dpr-cmpArtHead .dpr-compareClose').last().click()
      await page.waitForTimeout(150)
    }
  }

  let citeText = ''
  const citeLink = page.locator('.dpr-cmpCiteLink').first()
  if ((await citeLink.count()) > 0) {
    await citeLink.click()
    await page.locator('.dpr-cmpCitePopover').waitFor({ state: 'visible', timeout: 30000 })
    const citeTitle = page.locator('.dpr-cmpCitePopover h3')
    await citeTitle.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {})
    citeText = (await page.locator('.dpr-cmpCitePopover').innerText()).trim()
    if (!citeText || citeText.includes('正在核对')) findings.push('引用卡一直停在加载态')
    await shot('compare-v2-cite.png', '.dpr-cmpCitePopover')
    await page.locator('.dpr-cmpCiteHead .dpr-compareClose').first().click()
  } else {
    findings.push('全文里没有引用蓝链')
  }

  // 选区批注：在第一个正文段落里选 40 个字符，点「加入批注」。
  const selected = await page.evaluate(() => {
    const block = [...document.querySelectorAll('.dpr-cmpPaperPane p.dpr-cmpBlock[data-block-id]')].find((item) => {
      const probe = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
      while (probe.nextNode()) {
        if (probe.currentNode.textContent.trim().length > 30) return true
      }
      return false
    })
    if (!block) return false
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let node = null
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim().length > 30) {
        node = walker.currentNode
        break
      }
    }
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(40, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) findings.push('无法在正文里建立选区')
  else {
    await page.locator('.dpr-cmpSelBar').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('.dpr-cmpSelBar textarea').fill('这条批注来自对照视图测试。')
    await page.getByRole('button', { name: '加入批注', exact: true }).click()
    await page.locator('.dpr-cmpNoteItem').first().waitFor({ state: 'visible', timeout: 8000 })
    const noteCount = await page.locator('.dpr-cmpNoteItem').count()
    if (noteCount < 1) findings.push('批注没有进工作台列表')
    const markCount = await page.locator('.dpr-cmpMark, .dpr-cmpMarkLink').count()
    if (markCount < 1) findings.push('批注后正文没有逐字高亮')
    const noteShot = await shot('compare-v2-note.png', '.dpr-cmpWorkspace')
    const highlightShot = await shot('compare-v2-highlight.png', '.dpr-cmpPaperPane')

    const pane = page.locator('.dpr-cmpPaperPane').first()
    const langButton = pane.locator('.dpr-cmpLangBtn').first()
    await langButton.click()
    await page.waitForTimeout(900)
    const zhText = await pane.innerText()
    if (!/引言|抗菌|耐药|摘要|结果/.test(zhText)) findings.push('切到中文后没有出现译文')
    if ((await pane.locator('.dpr-cmpTarget').count()) > 0) findings.push('中文模式不应出现对照双段')
    const tableTrans = await pane.locator('.dpr-cmpTableTrans').count()
    if (tableTrans < 1) findings.push('中文模式没有表格译文')
    const tableCells = await pane.locator('.dpr-cmpTableGrid th, .dpr-cmpTableGrid td').count()
    if (tableCells < 32) findings.push('32 列表没有拆成网格：' + tableCells)
    const zhShot = await shot('compare-v2-zh.png', '.dpr-cmpPaperPane')
    await langButton.click()
    await page.waitForTimeout(500)
    const bilingual = await pane.locator('.dpr-cmpTarget').count()
    if (bilingual < 1) findings.push('切到对照没有目标译文段')
    const bilingualShot = await shot('compare-v2-bilingual.png', '.dpr-cmpPaperPane')
    await langButton.click()
    await page.waitForTimeout(300)
    if ((await pane.locator('.dpr-cmpTarget').count()) > 0) findings.push('切回原文仍残留对照段')

    await pane.getByRole('button', { name: '术语', exact: true }).click()
    await page.locator('.dpr-citeOverlay').waitFor({ state: 'visible', timeout: 8000 })
    const glossaryRows = await page.locator('.dpr-glossaryRow').count()
    if (glossaryRows < 1) findings.push('术语表没有行')
    await page.locator('.dpr-citeClose').first().click()

    await page.locator('.dpr-cmpNoteItem .dpr-back').filter({ hasText: '删除' }).first().click()
    await page.waitForTimeout(600)
    console.log('批注/语言截图：' + [noteShot, highlightShot, zhShot, bilingualShot].filter(Boolean).join(' | '))
  }

  let answer = ''
  if (args.withLlm) {
    await page.getByRole('tab', { name: '对话', exact: true }).first().click()
    const assistantBefore = await page.locator('.dpr-cmpMsg.is-assistant').count()
    const composer = page.locator('.dpr-cmpComposer textarea').first()
    await composer.fill('这两篇论文的方法有什么不同？请按论文分别说明。')
    await composer.press('Enter')
    await page.waitForFunction(
      (count) => document.querySelectorAll('.dpr-cmpMsg.is-assistant').length > count,
      assistantBefore,
      { timeout: 180000 },
    )
    answer = (await page.locator('.dpr-cmpMsg.is-assistant').last().innerText()).trim()
    if (answer.length < 80) findings.push('工作台回答太短：' + answer.length)
    if (!/P1|P2|对照|方法/.test(answer)) findings.push('工作台回答没有明显对照内容')
    await shot('compare-v2-answer.png', '.dpr-comparePanel')
  }

  // 引用对照：用同一套真实作业对 + 真实 blockId 打开 v2 视图。
  const candidates = await page.evaluate(async () => {
    const library = await (await fetch('doraemon-paper-reader/api/library', { cache: 'no-store' })).json()
    const papers = Array.isArray(library.papers) ? library.papers : []
    const out = []
    for (const paper of papers) {
      try {
        const doc = await (
          await fetch('doraemon-paper-reader/api/jobs/' + paper.jobId + '/mirrordoc.json', { cache: 'no-store' })
        ).json()
        const block = (doc.blocks || []).find(
          (item) => item.type === 'paragraph' && String(item.text || '').length > 120 && item.id,
        )
        if (block) out.push({ jobId: paper.jobId, title: paper.title, blockId: block.id })
        if (out.length >= 2) break
      } catch {
        // 跳过残缺作业。
      }
    }
    return out
  })
  let citationShot = ''
  let verdict = ''
  if (candidates.length >= 2) {
    await page.locator('.dpr-compareClose').first().click()
    await page.waitForTimeout(300)
    await page.evaluate((payload) => {
      window.dispatchEvent(
        new CustomEvent('doraemon-paper-reader:compare', {
          detail: {
            mode: 'citation',
            jobIds: [payload[0].jobId, payload[1].jobId],
            citing: {
              jobId: payload[0].jobId,
              blockId: payload[0].blockId,
              number: 12,
              title: payload[0].title,
            },
          },
        }),
      )
    }, candidates)
    await page.locator('.dpr-cmpCitingBanner').waitFor({ state: 'visible', timeout: 15000 })
    const banner = (await page.locator('.dpr-cmpCitingBanner').innerText()).trim()
    if (!banner.includes('引用 [12]')) findings.push('引用对照没有引用处横幅：' + banner.slice(0, 80))
    citationShot = await shot('compare-v2-citation.png', '.dpr-comparePanel')
    if (args.withLlm) {
      await page.getByRole('button', { name: '引用判断', exact: true }).first().click()
      await page.locator('.dpr-cmpArtWindow .dpr-cmpArtText').waitFor({ state: 'visible', timeout: 120000 })
      verdict = (await page.locator('.dpr-cmpArtWindow .dpr-cmpArtText').innerText()).trim()
      if (!/支持|相反|证据不足/.test(verdict)) findings.push('引用判断没有支持度结论：' + verdict.slice(0, 80))
      await shot('compare-v2-verdict.png', '.dpr-cmpArtWindow')
    }
  } else {
    findings.push('找不到可用于引用对照的段落')
  }

  if (args.withLlm && answer) {
    await page.locator('.dpr-compareClose').first().click()
    await page.waitForTimeout(300)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openMainInterface()
    await page.locator('.dpr-surveyCard').first().click()
    await page.locator('.dpr-surveyRow').first().waitFor({ state: 'visible', timeout: 10000 })
    const againRows = page.locator('.dpr-surveyRow')
    const pickAgain = async (text) => {
      const row = againRows.filter({ hasText: text }).first()
      if ((await row.count()) === 0) return false
      await row.locator('input[type=checkbox]').check()
      return true
    }
    const againA = preferredPapers[0] ? await pickAgain(preferredPapers[0].title) : false
    const againB = preferredPapers[1] ? await pickAgain(preferredPapers[1].title) : false
    if (!againA || !againB) {
      const again = page.locator('.dpr-surveyRow input[type=checkbox]')
      await again.nth(0).check()
      await again.nth(1).check()
    }
    await page.getByRole('button', { name: /开始对照/ }).first().click()
    await page.locator('.dpr-comparePanel').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('.dpr-cmpMsg.is-assistant').first().waitFor({ state: 'visible', timeout: 15000 })
    const restored = await page.locator('.dpr-cmpMsg').count()
    if (restored < 2) findings.push('工作台消息刷新后没有恢复：' + restored)
    await shot('compare-v2-persist.png', '.dpr-cmpWorkspace')
  }

  console.log(
    '布局：左 ' +
      (leftBox?.width || 0) +
      'px / 右 ' +
      (rightBox?.width || 0) +
      'px；正文块 ' +
      blockCount +
      '；蓝链 ' +
      linkCount +
      '；公式 ' +
      formulaSvgCount +
      ' 个 SVG / ' +
      katexCount +
      ' 个 KaTeX / ' +
      latexCount +
      ' 个 LaTeX',
  )
  console.log('对照表：' + (args.withLlm ? tableRows + ' 行 / ' + anchors + ' 锚点' : '未跑（没有 --with-llm）'))
  console.log('折线图：' + (args.withLlm ? linePoints + ' 点 / ' + lineAnchors + ' 锚点' : '未跑（没有 --with-llm）'))
  console.log('产物：' + artItems + ' 项；结构图 ' + chartRows + ' 行')
  console.log('引用卡：' + citeText.slice(0, 100))
  console.log('工作台回答：' + (answer ? answer.slice(0, 160) : '未跑（没有 --with-llm）'))
  console.log('引用判断：' + (verdict ? verdict.slice(0, 160) : '未跑（没有 --with-llm）'))
  console.log('截图：' + [layoutShot, formulaShot, artShot, citationShot].filter(Boolean).join(' | '))
  console.log('页面 console error：' + (errors.length === 0 ? '无' : errors.join(' || ')))
  console.log(findings.length === 0 ? '结论：对照工作台 v2 L2 通过' : '结论：不通过 → ' + findings.join('；'))
  if (findings.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
