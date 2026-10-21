#!/usr/bin/env node
// L2：真实 dev 实例里上传 PDF → 后台抄写 → 打开阅读页。
//
// 用法：
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/e2e/pdf-import.mjs --url "http://127.0.0.1:3106/?token=…" [--pdf <pdf>] [--out <dir>]

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

function parseArgs(argv) {
  const out = { mode: 'run', headless: true, sendMode: 'enter' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--url') out.url = argv[++i]
    else if (token === '--pdf') out.pdf = argv[++i]
    else if (token === '--out') out.out = argv[++i]
    else if (token === '--profile') out.profile = argv[++i]
    else if (token === '--headless') out.headless = true
    else if (token === '--headed') out.headless = false
    else if (token === '--send-mode') out.sendMode = argv[++i]
    else throw new Error('未知参数：' + token)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) throw new Error('必须给 --url（dev 实例打印出来的带 token 地址）')

const pdfPath = path.resolve(args.pdf ?? 'D:\\振动传感器\\物流\\sensors-22-04003.pdf')
const profileDir = path.resolve(args.profile ?? '工具/gen/_e2e-pdf-profile')
const outDir = path.resolve(args.out ?? '工具/gen/pdf-import-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const errors = []

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
  // 每次走查都从新会话开始，避免上一轮的工具清单/上下文混进来。
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

try {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('doraemonPaperReader.lastJobId')
    } catch {
      // localStorage may be unavailable in a locked-down profile.
    }
  })
  await page.goto(args.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await openMainInterface()
  await page.locator('.dpr-libraryItem').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'library.png') })
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.waitForTimeout(350)
  if (await clickIfVisible('换一份 PDF')) await page.waitForTimeout(300)
  await page.locator('.dpr-pane input[type=file]').waitFor({ state: 'visible', timeout: 10000 })

  // 拖入路径：先模拟宿主窗口收到 dragenter，再在插件 drop 区完成 drop。
  // 插件必须在窗口捕获阶段接管，避免宿主全屏拖放遮罩留下。
  const paneBox = await page.locator('.dpr-pane').first().boundingBox()
  await page.evaluate(({ x, y }) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new TextEncoder().encode('%PDF-1.4\n%%EOF\n')], 'drop-test.pdf', { type: 'application/pdf' }),
    )
    document.dispatchEvent(
      new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
      }),
    )
    const drop = document.querySelector('.dpr-drop')
    drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { x: Math.round((paneBox?.x || 0) + 20), y: Math.round((paneBox?.y || 0) + 20) })
  await page.waitForTimeout(350)
  const hostDropOverlay = (await page.locator('body').innerText()).includes('文件或图片拖动到此处即可添加')
  if (hostDropOverlay) errors.push('插件内拖放后残留了宿主全屏拖放遮罩')
  const dropMeta = (await page.locator('.dpr-fileCard').first().innerText()).trim()
  if (!dropMeta.includes('drop-test.pdf')) errors.push('拖入没有选中 PDF：' + JSON.stringify(dropMeta))
  const dropCount = await page.getByText('drop-test.pdf', { exact: false }).count()
  if (dropCount > 1) errors.push('拖入事件冒泡到了宿主输入框：出现 ' + dropCount + ' 处 drop-test.pdf')

  await page.locator('.dpr-pane input[type=file]').setInputFiles(pdfPath)
  await page.getByRole('button', { name: '大肥鱼给朕速速抄写！！！', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.locator('.dpr-load').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1200)
  const firstTimer = (await page.locator('.dpr-timer').first().innerText()).trim()
  await mkdir(outDir, { recursive: true })
  await page.locator('.dpr-pane').first().screenshot({ path: path.join(outDir, 'loading.png') })

  // 离开页签再回来：任务仍在宿主里跑，页面应恢复计时与阶段。
  await page.getByRole('button', { name: '回到主界面', exact: true }).click()
  await page.locator('.dpr-pane .dpr-card').first().click()
  await page.locator('.dpr-load').waitFor({ state: 'visible', timeout: 15000 })
  const resumedTimer = (await page.locator('.dpr-timer').first().innerText()).trim()
  if (firstTimer === '00:00' && resumedTimer === '00:00') {
    errors.push('计时器没有启动')
  }

  await page.getByRole('button', { name: '打开阅读页', exact: true }).waitFor({ state: 'visible', timeout: 180000 })
  await page.getByRole('button', { name: '打开阅读页', exact: true }).click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const title = (await page.locator('.dpr-readerTitle').innerText()).trim()
  if (!title.includes('Smart Sticker')) errors.push('阅读页标题不对：' + JSON.stringify(title))
  const pageBadge = page.locator('.dpr-readerPage').first()
  if ((await pageBadge.count()) === 0) {
    errors.push('阅读页没有渲染原版页码入口')
  } else {
    await pageBadge.click()
    await page.locator('.dpr-sourceOverlay').waitFor({ state: 'visible', timeout: 10000 })
    const sourceImage = page.locator('.dpr-sourceImage')
    await sourceImage.waitFor({ state: 'visible', timeout: 10000 })
    const sourceLoaded = await sourceImage.evaluate((element) => ({
      complete: element.complete,
      width: element.naturalWidth,
      src: element.getAttribute('src'),
    }))
    if (!sourceLoaded.complete || sourceLoaded.width === 0) {
      errors.push('原版页查看器图片没有加载：' + JSON.stringify(sourceLoaded))
    }
    await page.getByRole('button', { name: '关闭', exact: true }).last().click()
    await page.locator('.dpr-sourceOverlay').waitFor({ state: 'detached', timeout: 5000 })
  }
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 900) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(500)
  const images = await page.evaluate(() =>
    [...document.querySelectorAll('.dpr-reader img')].map((image) => ({
      src: image.getAttribute('src'),
      complete: image.complete,
      width: image.naturalWidth,
    })),
  )
  const broken = images.filter((image) => !image.complete || image.width === 0)
  await page.screenshot({ path: path.join(outDir, 'reader.png') })

  // 选区 → 批注草稿 → 主对话输入区编辑 → 发送 → 段尾气泡 → 高亮。
  const dockBeforeSelection = page.locator('.dpr-annotationDock').last()
  const dockBeforeText = (await dockBeforeSelection.count()) > 0
    ? (await dockBeforeSelection.innerText()).trim()
    : ''
  const baselineAnnotationCount = Number((dockBeforeText.match(/(\d+)\s*个批注/) || [])[1]) || 0
  const selected = await page.evaluate(() => {
    const text = document.querySelector('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')
    if (!text) return false
    text.closest('.dpr-readerP').scrollIntoView({ block: 'center' })
    const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(80, node.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    text.closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!selected) errors.push('没有可选的正文段落')
  await page.waitForTimeout(350)
  const selectionBar = page.locator('.dpr-selectionBar').last()
  const barBefore = await selectionBar.boundingBox()
  const selectedRect = await page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  })
  if (barBefore && selectedRect) {
    const aboveGap = selectedRect.top - (barBefore.y + barBefore.height)
    const belowGap = barBefore.y - selectedRect.bottom
    if (Math.min(Math.abs(aboveGap), Math.abs(belowGap)) > 40) {
      errors.push('选区浮层初始位置没有贴在所选段落旁边：' + JSON.stringify({ barBefore, selectedRect }))
    }
  }
  if (barBefore && selectedRect && barBefore.height > 0) {
    const side = barBefore.y < selectedRect.top ? 'above' : 'below'
    const viewTop = await page.evaluate(() => {
      const toolbar = document.querySelector('.dpr-readerBar')
      const reader = document.querySelector('.dpr-reader')
      return (toolbar ? toolbar.getBoundingClientRect().bottom : (reader?.getBoundingClientRect().top || 0)) + 8
    })
    const samples = []
    for (const target of [0, 80, 160, 260, 420, 700, 1000, 1400, 1800, 1400, 900, 500, 200, 0, 1200, 0]) {
      await page.evaluate((value) => {
        const pane = document.querySelector('.dpr-reader') || document.querySelector('.dpr-readerPane')
        if (pane) pane.scrollTop = value
      }, target)
      await page.waitForTimeout(70)
      const measured = await page.evaluate(() => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return null
        const anchorRect = selection.getRangeAt(0).getBoundingClientRect()
        const bar = document.querySelector('.dpr-selectionBar')
        if (!bar) return null
        const barRect = bar.getBoundingClientRect()
        return {
          anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
          bar: { top: barRect.top, bottom: barRect.bottom, height: barRect.height },
        }
      })
      if (!measured) {
        errors.push('滚动 ' + target + ' 时选区或浮层消失')
        continue
      }
      const expected = side === 'above'
        ? measured.anchor.top - 8 - measured.bar.height
        : measured.anchor.bottom + 8
      const clamped = Math.max(viewTop, Math.min(1000 - 12 - measured.bar.height, expected))
      samples.push({ target, expected, clamped, measured })
      if (Math.abs(measured.bar.top - clamped) > 2) {
        errors.push('滚动 ' + target + ' 时浮层没有保持相对位置/正确夹取：' + JSON.stringify({ side, expected: clamped, measured }))
      }
      if (measured.bar.top < viewTop - 1 || measured.bar.bottom > 1000) {
        errors.push('滚动 ' + target + ' 时浮层越过视口边界：' + JSON.stringify(measured))
      }
    }
    // 未触边界时必须保持恒定相对距离（不慢半拍、不漂移）。
    const relative = samples
      .filter((sample) => sample.expected === sample.clamped)
      .map((sample) => (side === 'above'
        ? sample.measured.anchor.top - sample.measured.bar.bottom
        : sample.measured.bar.top - sample.measured.anchor.bottom))
    if (relative.some((gap) => Math.abs(gap - 8) > 1.5)) {
      errors.push('选区与浮层的相对距离不恒定：' + JSON.stringify(relative))
    }
    // 选段越出视口后必须停在边界，不能继续移动。
    const outOfView = samples.filter((sample) => (
      sample.measured.anchor.bottom < viewTop || sample.measured.anchor.top > 1000
    ))
    for (const sample of outOfView) {
      const atEdge = sample.measured.anchor.bottom < viewTop
        ? Math.abs(sample.measured.bar.top - viewTop) <= 2
        : Math.abs(sample.measured.bar.bottom - 988) <= 2
      if (!atEdge) errors.push('选段离开视口后浮层没有停在边界：' + JSON.stringify(sample))
    }
  }
  const askButton = page.getByRole('button', { name: '问大肥鱼', exact: true })
  if ((await askButton.count()) === 0) errors.push('选区后没有出现「问大肥鱼」')
  else await askButton.click()
  await page.waitForTimeout(600)
  const dock = page.locator('.dpr-annotationDock').last()
  if ((await dock.count()) === 0) errors.push('加入批注后没有出现主对话批注条')
  else {
    const dockText = (await dock.innerText()).trim()
    const addedCount = Number((dockText.match(/(\d+)\s*个批注/) || [])[1]) || 0
    if (addedCount !== baselineAnnotationCount + 1) {
      errors.push(
        '批注条数量没有增加一条：baseline=' +
          baselineAnnotationCount +
          ' actual=' +
          addedCount +
          ' text=' +
          JSON.stringify(dockText),
      )
    }
    const annotationQuestion = page.locator('.dpr-annotationItem textarea').first()
    if ((await annotationQuestion.count()) > 0) {
      await annotationQuestion.fill('请分析这段引言与后文论证的关系。')
    }

    // 再加一条：验证「批注 1 / 批注 2」同时进入同一条用户消息，而不是各发一条。
    const secondSelected = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')]
      const text = texts[1]
      if (!text) return false
      text.closest('.dpr-readerP').scrollIntoView({ block: 'center' })
      const node = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()
      if (!node) return false
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(70, node.textContent.length))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      text.closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })
    if (!secondSelected) errors.push('无法选择第二段来构造批注 2')
    else {
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: '问大肥鱼', exact: true }).last().click()
      await page.waitForTimeout(300)
      const secondQuestion = page.locator('.dpr-annotationItem textarea').last()
      if ((await secondQuestion.count()) > 0) {
        await secondQuestion.fill('第二段与第一段是什么关系？')
      }
      const twoDock = (await dock.innerText()).trim()
      const secondCount = Number((twoDock.match(/(\d+)\s*个批注/) || [])[1]) || 0
      if (secondCount !== baselineAnnotationCount + 2) {
        errors.push(
          '批注条数量没有增加两条：baseline=' +
            baselineAnnotationCount +
            ' actual=' +
            secondCount +
            ' text=' +
            JSON.stringify(twoDock),
        )
      }
    }
    if ((await dock.locator('textarea[aria-label="整体问题"]').count()) > 0) {
      errors.push('批注条仍然保留了与主输入框重复的「整体问题」')
    }
    if ((await dock.getByRole('button', { name: '发送批注', exact: true }).count()) > 0) {
      errors.push('批注条仍然保留了独立的「发送批注」按钮')
    }
    // 不再点批注条自己的发送键：直接在主输入框写问题，按回车随主消息一起发。
    const composer = page.locator('[data-composer-input]').last()
    await composer.click()
    await composer.fill('请分析这两段的关系，并说明 Table 1 的作用。')
    const hasMainSend = await page.evaluate(() =>
      [...document.querySelectorAll('[data-composer-card] button')].some((button) => {
        const label = button.getAttribute('aria-label') || ''
        return !button.disabled && /^(发送|Send)/i.test(label)
      }),
    )
    if (!hasMainSend) errors.push('主输入框没有可用的发送键')
    if (args.sendMode === 'click') {
      const clicked = await page.evaluate(() => {
        const button = [...document.querySelectorAll('[data-composer-card] button')].find((candidate) => {
          const label = candidate.getAttribute('aria-label') || ''
          return !candidate.disabled && /^(发送|Send)/i.test(label)
        })
        if (!button) return false
        button.click()
        return true
      })
      if (!clicked) errors.push('无法点击主输入框的发送键')
    } else {
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(1500)
    const userBubble = page.locator('text=/批次：batch_/').last()
    const userText = (await userBubble.innerText().catch(() => '')).trim()
    if (!userText.includes('批注 1') || !userText.includes('批注 2')) {
      errors.push('用户消息没有同时显示「批注 1 / 批注 2」摘要：' + JSON.stringify(userText.slice(0, 500)))
    }
    if (!userText.includes('doraemon_read_annotations')) {
      errors.push('用户消息没有告诉模型调用批注读取工具')
    }
    if (/"segments"|"quote"|"annotations"\s*:/.test(userText)) {
      errors.push('用户消息里又出现了整包 JSON：' + JSON.stringify(userText.slice(0, 500)))
    }
    if (userText.length > 1200) errors.push('用户消息摘要仍然太长：' + userText.length + ' 字符')
    if (!userText.includes('整体问题：请分析这两段的关系')) {
      errors.push('用户消息没有带上主输入框里的问题：' + JSON.stringify(userText.slice(0, 500)))
    }
    await userBubble.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(300)

    // 摘要里没有原文；回答若出现 b0004 / 原文首句 / Table 1，说明工具确实把完整包交给了模型。
    const sawTool = await page
      .waitForFunction(
        () => {
          const text = document.body.innerText
          return (
            text.includes('b0004') ||
            text.includes('The supply chain is a vast and complex process')
          )
        },
        null,
        { timeout: 45000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!sawTool) errors.push('等待 45 秒仍未看到完整批注包被模型使用的证据（b0004 / 原文首句 / Table 1）')
    await page.screenshot({ path: path.join(outDir, 'ask.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(outDir, 'ask-dark.png') })
    await page.emulateMedia({ colorScheme: null })
  }

  const bubble = page.locator('.dpr-bubble').first()
  if ((await bubble.count()) === 0) errors.push('发送后段落结尾没有批注气泡')
  else {
    await bubble.click()
    await page.waitForTimeout(700)
    if ((await page.locator('.dpr-flash').count()) === 0) errors.push('点击批注气泡没有触发高亮动画')
    await page.screenshot({ path: path.join(outDir, 'jump.png') })
  }

  // 跨两段的选区：应显示「2 段一起问」。
  const multiSelected = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.dpr-readerBody .dpr-readerP[data-block-id] .dpr-readerText')]
    if (blocks.length < 2) return false
    const first = document.createTreeWalker(blocks[0], NodeFilter.SHOW_TEXT).nextNode()
    const second = document.createTreeWalker(blocks[1], NodeFilter.SHOW_TEXT).nextNode()
    if (!first || !second) return false
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(second, Math.min(60, second.textContent.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    blocks[1].closest('.dpr-readerP').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })
  if (!multiSelected) errors.push('无法构造跨两段选区')
  else {
    await page.waitForTimeout(300)
    const multiHint = (await page.locator('.dpr-selectionHint').innerText().catch(() => '')).trim()
    if (!/2 段|3 段/.test(multiHint)) errors.push('跨两段选区没有显示段数：' + JSON.stringify(multiHint))
    const multiAsk = page.getByRole('button', { name: '问大肥鱼', exact: true })
    if ((await multiAsk.count()) > 0) await multiAsk.click()
    await page.waitForTimeout(300)
    const pendingText = (await page.locator('.dpr-annotationDock').last().innerText().catch(() => '')).trim()
    if (!/2 段|3 段/.test(pendingText)) errors.push('批注条没有记录跨段批注：' + JSON.stringify(pendingText))
    const del = page.getByRole('button', { name: '删除', exact: true }).last()
    if ((await del.count()) > 0) await del.click()
  }

  // Table 1 / 图表 / 公式右键直接弹出批注框；再验证在浮层里打字不会把浮层清掉。
  const table = page.locator('.dpr-readerFigure[data-kind="table"]').first()
  const asset = (await table.count()) > 0 ? table : page.locator('.dpr-readerFigure').first()
  if ((await asset.count()) > 0) {
    await asset.click({ button: 'right' })
    await page.waitForTimeout(250)
    const selectionBar = page.locator('.dpr-selectionBar').last()
    if ((await selectionBar.count()) === 0) errors.push('右键 Table 1 / 图表没有弹出批注框')
    else {
      const selectionText = (await selectionBar.locator('textarea').getAttribute('placeholder')) || ''
      if (!selectionText) errors.push('特殊块批注框没有可输入的 textarea')
      await selectionBar.locator('textarea').click()
      await page.waitForTimeout(120)
      if (!(await selectionBar.isVisible().catch(() => false))) {
        errors.push('点进 Table 1 批注框后浮层立即消失')
      }
      await selectionBar.locator('textarea').pressSequentially('Table 1 的脆值阈值如何对应后文实验？')
      await page.waitForTimeout(150)
      if (!(await selectionBar.isVisible().catch(() => false))) {
        errors.push('在 Table 1 批注框里打字时浮层消失')
      }
      await page.screenshot({ path: path.join(outDir, 'table-annotation.png') })
      await page.getByRole('button', { name: '问大肥鱼', exact: true }).click()
      await page.waitForTimeout(300)
      const specialDock = (await page.locator('.dpr-annotationDock').last().innerText().catch(() => '')).trim()
      if (!/Table 1|Figure 1|图|表格|公式/.test(specialDock)) {
        errors.push('特殊块批注没有记录 Table 1/图表/公式标签：' + JSON.stringify(specialDock))
      }
      const del = page.getByRole('button', { name: '删除', exact: true }).last()
      if ((await del.count()) > 0) await del.click()
    }
  }

  // 刷新后从磁盘恢复：论文库仍在，阅读页与段尾气泡从 annotations.json 回来。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  if ((await page.locator('.dpr-readerTitle').count()) === 0) {
    await openMainInterface()
    const libraryItem = page.locator('.dpr-libraryItem').filter({ hasText: 'Smart Sticker Ultra-Low-Power' }).first()
    await libraryItem.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    if ((await libraryItem.count()) === 0) {
      errors.push('刷新后论文库没有这篇论文')
    } else {
      await libraryItem.click()
    }
  }
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })
  const restoredBubble = page.locator('.dpr-bubble').first()
  if ((await restoredBubble.count()) === 0) {
    errors.push('刷新后段尾批注气泡没有从 annotations.json 恢复')
  }
  await page.screenshot({ path: path.join(outDir, 'restored.png') })

  console.log(
    JSON.stringify(
      {
        title,
        firstTimer,
        resumedTimer,
        images: images.length,
        broken,
        warnings: ['聊天回答里的引用链接尚未稳定接入阅读页；当前使用段尾批注气泡高亮'],
        errors,
      },
      null,
      2,
    ),
  )
  if (broken.length > 0 || errors.length > 0) process.exitCode = 1
} catch (error) {
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'failed.png') }).catch(() => {})
  console.log('failure text', (await page.locator('body').innerText().catch(() => '')).slice(0, 3000))
  throw error
} finally {
  await context.close()
}
