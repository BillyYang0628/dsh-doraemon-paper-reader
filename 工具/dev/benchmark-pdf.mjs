#!/usr/bin/env node
// 用受管 Python 对真实作业跑一次 PDF 管线性能基线。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPythonRuntime } from '../../src/python-runtime.js'

const args = process.argv.slice(2)
const titleNeedle = args.includes('--title') ? args[args.indexOf('--title') + 1] : 'Smart Sticker'
const jobArg = args.includes('--job') ? args[args.indexOf('--job') + 1] : ''
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataRoot = path.join(process.env.DSH_HOME || 'D:/DSH/home', 'doraemon-paper-reader')
const jobsRoot = path.join(dataRoot, 'jobs')

async function findJob() {
  if (jobArg) return jobArg
  for (const id of await readdir(jobsRoot)) {
    try {
      const doc = JSON.parse(await readFile(path.join(jobsRoot, id, 'mirrordoc.json'), 'utf8'))
      if (String(doc?.meta?.title || '').toLowerCase().includes(titleNeedle.toLowerCase())) return id
    } catch {
      // 跳过预览/半成品。
    }
  }
  throw new Error('没有找到标题包含「' + titleNeedle + '」的已完成作业')
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: packageRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-6000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `退出码 ${code}`))
    })
  })
}

const jobId = await findJob()
const sourceDir = path.join(jobsRoot, jobId)
const pdf = path.join(sourceDir, 'original.pdf')
const pdfInfo = await stat(pdf)
const outRoot = path.join(packageRoot, '工具', 'gen', 'performance-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
await mkdir(outRoot, { recursive: true })
const outDir = await mkdtemp(path.join(outRoot, 'run-'))
const runtime = createPythonRuntime({ dataRoot, packageRoot, basePython: process.env.DPR_PYTHON || 'python' })
const python = (await runtime.ensure()).executable
const stages = {}

let started = performance.now()
await run(python, [
  path.join(packageRoot, '工具', 'pdf-pipeline', 'extract_pdf.py'),
  pdf,
  '--out',
  outDir,
  '--dpi',
  '200',
  '--progress',
])
stages.extractMs = Math.round(performance.now() - started)

started = performance.now()
await run(python, [path.join(packageRoot, '工具', 'pdf-pipeline', 'reconcile_layout.py'), outDir, '--progress'])
stages.reconcileMs = Math.round(performance.now() - started)

started = performance.now()
await run(python, [
  path.join(packageRoot, '工具', 'pdf-pipeline', 'render_html.py'),
  path.join(outDir, 'mirrordoc.json'),
  '--out',
  path.join(outDir, 'paper.html'),
])
stages.renderMs = Math.round(performance.now() - started)

const doc = JSON.parse(await readFile(path.join(outDir, 'mirrordoc.json'), 'utf8'))
const report = {
  at: new Date().toISOString(),
  jobId,
  title: doc?.meta?.title || '',
  pdfBytes: pdfInfo.size,
  pages: Array.isArray(doc?.sourcePages) ? doc.sourcePages.length : Number(doc?.meta?.pageCount) || 0,
  blocks: Array.isArray(doc?.blocks) ? doc.blocks.length : 0,
  ...stages,
  totalMs: stages.extractMs + stages.reconcileMs + stages.renderMs,
  outDir,
}
await writeFile(path.join(outDir, 'benchmark.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
