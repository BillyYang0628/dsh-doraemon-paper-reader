#!/usr/bin/env node
// D 验收：Figure 1 右键批注 → 主输入框随发 → 模型对 assetPath 调用 read_image。
// 用法：node 工具/e2e/visual-qa.mjs --url "http://127.0.0.1:3115/?token=…"

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')
const args = process.argv.slice(2)
let url = ''
let outDir = '工具/gen/visual-qa-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') url = args[++i]
  else if (args[i] === '--out') outDir = args[++i]
}
if (!url) throw new Error('必须给 --url')

const errors = []
const context = await chromium.launchPersistentContext('工具/gen/_e2e-visual-profile', {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))

async function clickIfVisible(name) {
  const target = page.getByRole('button', { name, exact: true }).first()
  if (await target.isVisible().catch(() => false)) {
    await target.click()
    return true
  }
  return false
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  if (await clickIfVisible('打开右侧边栏')) await page.waitForTimeout(500)
  await clickIfVisible('新标签页')
  await page.waitForTimeout(500)
  const entry = page.getByRole('button', { name: '论文阅读器' }).last()
  if (await entry.isVisible().catch(() => false)) await entry.click()
  await page.locator('.dpr-libraryItem').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.dpr-libraryItem').first().click()
  await page.locator('.dpr-readerTitle').waitFor({ state: 'visible', timeout: 30000 })

  const figure = page.locator('.dpr-readerFigure[data-label="Figure 1"]').first()
  if ((await figure.count()) === 0) throw new Error('没有找到 Figure 1')
  await figure.click({ button: 'right' })
  await page.waitForTimeout(250)
  const bar = page.locator('.dpr-selectionBar').last()
  if ((await bar.count()) === 0) throw new Error('Figure 1 右键没有弹出批注框')
  await bar.locator('textarea').click()
  await bar.locator('textarea').pressSequentially('请先看这张图：Figure 1 里的设备外形和可见部件是什么？')
  await page.waitForTimeout(150)
  if (!(await bar.isVisible().catch(() => false))) errors.push('Figure 1 批注框在输入时消失')
  await page.getByRole('button', { name: '问大肥鱼', exact: true }).click()
  await page.waitForTimeout(300)

  const composer = page.locator('[data-composer-input]').last()
  await composer.click()
  await composer.fill('请先对 Figure 1 的图片调用 read_image，再回答。')
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-composer-card] button')].find((candidate) => {
      const label = candidate.getAttribute('aria-label') || ''
      return !candidate.disabled && /^(发送|Send)/i.test(label)
    })
    if (!button) return false
    button.click()
    return true
  })
  if (!clicked) errors.push('没有点击主发送键')

  await page.locator('text=/批次：batch_/').last().waitFor({ state: 'visible', timeout: 15000 })
  const sawReadImage = await page
    .waitForFunction(
      () => {
        const text = document.body.innerText
        return text.includes('读取图片')
      },
      null,
      { timeout: 90000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!sawReadImage) errors.push('模型没有对 Figure 1 的 assetPath 调用 read_image（界面未出现「读取图片」）')
  const finished = await page
    .waitForFunction(() => document.body.innerText.includes('已完成'), null, { timeout: 90000 })
    .then(() => true)
    .catch(() => false)
  if (!finished) errors.push('视觉问答等待 90 秒仍未完成')
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'visual-qa.png') })
  console.log(JSON.stringify({ errors, sawReadImage, finished }, null, 2))
  if (errors.length > 0) process.exitCode = 1
} finally {
  await context.close()
}
