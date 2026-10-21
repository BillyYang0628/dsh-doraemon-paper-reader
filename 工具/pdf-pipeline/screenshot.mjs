#!/usr/bin/env node
// Screenshot a local HTML reading prototype with the system Edge.
//
// Usage:
//   $env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
//   node 工具/pdf-pipeline/screenshot.mjs <paper.html> <out-dir>

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.DPR_PLAYWRIGHT ?? 'playwright-core')

const args = process.argv.slice(2)
const htmlPath = args[0]
const outDir = args[1]
const anchorIndex = args.indexOf('--anchor')
const anchor = anchorIndex >= 0 ? args[anchorIndex + 1] : ''
if (!htmlPath || !outDir) {
  throw new Error('usage: screenshot.mjs <paper.html> <out-dir>')
}

const errors = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'networkidle' })
  // Trigger lazy-loaded figures before checking naturalWidth.
  await page.evaluate(async () => {
    const step = 800
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(500)
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'html-top.png') })

  const figure = page.locator('figure.figure').first()
  if ((await figure.count()) > 0) await figure.screenshot({ path: path.join(outDir, 'html-figure.png') })

  const table = page.locator('figure.table').first()
  if ((await table.count()) > 0) await table.screenshot({ path: path.join(outDir, 'html-table.png') })

  const equation = page.locator('figure.equation').first()
  if ((await equation.count()) > 0) await equation.screenshot({ path: path.join(outDir, 'html-equation.png') })

  if (anchor) {
    const target = page.locator(anchor).first()
    if ((await target.count()) > 0) {
      await target.scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(outDir, 'html-section.png') })
    }
  }

  const images = await page.evaluate(() =>
    [...document.images].map((image) => ({
      src: image.getAttribute('src'),
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  )
  const broken = images.filter((image) => !image.complete || image.width === 0)
  console.log(JSON.stringify({ images: images.length, broken, errors }, null, 2))
  if (broken.length > 0 || errors.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
