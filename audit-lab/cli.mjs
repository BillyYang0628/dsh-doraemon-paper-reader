#!/usr/bin/env node
// 独立 PDF 审计实验室 CLI。只编排 Python 管线，不 import 插件宿主或浏览器代码。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const labRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(labRoot, '..')
const bundledPipeline = path.join(labRoot, 'pdf-pipeline')
const pipelineRoot = existsSync(path.join(bundledPipeline, 'extract_pdf.py'))
  ? bundledPipeline
  : path.join(repoRoot, '工具', 'pdf-pipeline')
const python = process.env.DPR_PYTHON || 'python'

function usage() {
  console.log(`大肥鱼 PDF 结构审计实验室

用法：
  node audit-lab/cli.mjs self-check
  node audit-lab/cli.mjs extract <paper.pdf> [--out <dir>] [--dpi 144]
  node audit-lab/cli.mjs audit <job-dir> [--out <dir>] [--baseline <report.json>]
  node audit-lab/cli.mjs regression [--cases <json>] [--out <dir>] [--case <id>]

通用参数：
  --python <path>        Python 解释器，默认 DPR_PYTHON 或 python
  --dry-run              只打印将要执行的命令

审计边界：
  extract 依次执行 extract_pdf.py → reconcile_layout.py → audit_structure.py。
  audit_structure.py 只重算确定性结构，不改写 MirrorDoc。`)
}

function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数值`)
  return value
}

function resolvePath(value) {
  return path.resolve(process.cwd(), value)
}

function timestamp() {
  const now = new Date()
  const text = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return text.replace('T', '-')
}

function slug(value) {
  return path
    .basename(value, path.extname(value))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'paper'
}

function run(command, args, { dryRun = false } = {}) {
  console.log('$ ' + [command, ...args].map((item) => JSON.stringify(item)).join(' '))
  if (dryRun) return
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} 执行失败，退出码 ${result.status}`)
  }
}

function pipelinePath(name) {
  const target = path.join(pipelineRoot, name)
  if (!existsSync(target)) throw new Error(`找不到审计工具：${target}`)
  return target
}

async function commandExtract(args) {
  let pdf = ''
  let out = ''
  let dpi = '144'
  let failOn = 'error'
  let selectedPython = python
  let dryRun = false
  let skipAudit = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--out') out = requireValue(args, index++, token)
    else if (token === '--dpi') dpi = requireValue(args, index++, token)
    else if (token === '--fail-on') failOn = requireValue(args, index++, token)
    else if (token === '--python') selectedPython = requireValue(args, index++, token)
    else if (token === '--dry-run') dryRun = true
    else if (token === '--skip-audit') skipAudit = true
    else if (token === '--help' || token === '-h') {
      usage()
      return
    } else if (token.startsWith('--')) throw new Error(`extract 不认识的参数：${token}`)
    else if (!pdf) pdf = token
    else throw new Error(`多余的 PDF 参数：${token}`)
  }

  if (!pdf) throw new Error('extract 需要 PDF 路径')
  if (!['error', 'warning', 'never'].includes(failOn)) {
    throw new Error('--fail-on 只支持 error / warning / never')
  }
  const source = resolvePath(pdf)
  if (!existsSync(source)) throw new Error(`PDF 不存在：${source}`)
  const output = out ? resolvePath(out) : path.join(labRoot, 'work', `${slug(source)}-${timestamp()}`)
  await mkdir(output, { recursive: true })

  run(selectedPython, [pipelinePath('extract_pdf.py'), source, '--out', output, '--dpi', dpi, '--progress'], {
    dryRun,
  })
  run(selectedPython, [pipelinePath('reconcile_layout.py'), output, '--progress'], { dryRun })
  if (!skipAudit) {
    const auditOut = path.join(output, 'structure-audit')
    await mkdir(auditOut, { recursive: true })
    run(
      selectedPython,
      [pipelinePath('audit_structure.py'), output, '--out', auditOut, '--fail-on', failOn],
      { dryRun },
    )
  }
  console.log(`AUDIT_LAB_OUT=${output}`)
}

async function commandAudit(args) {
  let job = ''
  let out = ''
  let baseline = ''
  let failOn = 'error'
  let selectedPython = python
  let dryRun = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--out') out = requireValue(args, index++, token)
    else if (token === '--baseline') baseline = requireValue(args, index++, token)
    else if (token === '--fail-on') failOn = requireValue(args, index++, token)
    else if (token === '--python') selectedPython = requireValue(args, index++, token)
    else if (token === '--dry-run') dryRun = true
    else if (token === '--help' || token === '-h') {
      usage()
      return
    } else if (token.startsWith('--')) throw new Error(`audit 不认识的参数：${token}`)
    else if (!job) job = token
    else throw new Error(`多余的作业参数：${token}`)
  }

  if (!job) throw new Error('audit 需要 MirrorDoc 作业目录')
  if (!['error', 'warning', 'never'].includes(failOn)) {
    throw new Error('--fail-on 只支持 error / warning / never')
  }
  const jobDir = resolvePath(job)
  if (!existsSync(jobDir)) throw new Error(`作业目录不存在：${jobDir}`)
  const output = out ? resolvePath(out) : path.join(jobDir, 'structure-audit')
  await mkdir(output, { recursive: true })
  const commandArgs = [pipelinePath('audit_structure.py'), jobDir, '--out', output, '--fail-on', failOn]
  if (baseline) commandArgs.push('--baseline', resolvePath(baseline))
  run(selectedPython, commandArgs, { dryRun })
  console.log(`AUDIT_LAB_OUT=${output}`)
}

async function commandRegression(args) {
  let cases = path.join(pipelineRoot, 'regression_cases.json')
  let out = path.join(labRoot, 'work', `regression-${timestamp()}`)
  let selectedPython = python
  let dryRun = false
  const passthrough = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--cases') cases = resolvePath(requireValue(args, index++, token))
    else if (token === '--out') out = resolvePath(requireValue(args, index++, token))
    else if (token === '--python') selectedPython = requireValue(args, index++, token)
    else if (token === '--dry-run') dryRun = true
    else if (token === '--source' || token === '--case' || token === '--dsh-home') {
      passthrough.push(token, requireValue(args, index++, token))
    } else if (token === '--keep-going') passthrough.push(token)
    else if (token === '--help' || token === '-h') {
      usage()
      return
    } else {
      throw new Error(`regression 不认识的参数：${token}`)
    }
  }

  await mkdir(out, { recursive: true })
  run(
    selectedPython,
    [pipelinePath('regression_check.py'), '--cases', cases, '--out', out, ...passthrough],
    { dryRun },
  )
  console.log(`AUDIT_LAB_OUT=${out}`)
}

async function commandSelfCheck() {
  const required = [
    'extract_pdf.py',
    'reconcile_layout.py',
    'audit_structure.py',
    'regression_check.py',
    'regression_cases.json',
    'test_pipeline.py',
    'requirements.txt',
  ]
  for (const name of required) pipelinePath(name)
  const cases = JSON.parse(await readFile(path.join(pipelineRoot, 'regression_cases.json'), 'utf8'))
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('回归案例为空')
  const version = spawnSync(python, ['--version'], { encoding: 'utf8' })
  if (version.error) throw version.error
  if (version.status !== 0) throw new Error('Python 解释器不可用')
  const packageJson = JSON.parse(await readFile(path.resolve(labRoot, 'package.json'), 'utf8'))
  console.log(
    JSON.stringify(
      {
        ok: true,
        lab: packageJson.name,
        version: packageJson.version,
        pipelineRoot,
        python,
        pythonVersion: String(version.stdout || version.stderr || '').trim(),
        publicCases: cases.length,
        scopeLimits: ['deterministic-structure-only', 'no-semantic-cell-proof', 'no-network-required'],
      },
      null,
      2,
    ),
  )
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    usage()
    return
  }
  if (command === 'extract') return commandExtract(args)
  if (command === 'audit') return commandAudit(args)
  if (command === 'regression') return commandRegression(args)
  if (command === 'self-check') return commandSelfCheck()
  throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  console.error('审计实验室错误：' + error.message)
  process.exitCode = 1
})
