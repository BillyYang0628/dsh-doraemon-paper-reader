#!/usr/bin/env node
// B7 语义目录评估：从本地真实 MirrorDoc 选择不同论文，生成并校验目录。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chatJson } from '../../src/llm.js'
import {
  buildOutlineSource,
  buildSemanticOutlinePrompt,
  fallbackOutline,
  normalizeSemanticOutline,
} from '../../src/outline.js'

const args = process.argv.slice(2)
const options = {
  jobs: 'D:\\DSH\\home\\doraemon-paper-reader\\jobs',
  out: '工具/gen/B7-20261022/outline-eval',
  max: 5,
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--jobs') options.jobs = args[++index]
  else if (args[index] === '--out') options.out = args[++index]
  else if (args[index] === '--max') options.max = Number(args[++index])
  else throw new Error('未知参数：' + args[index])
}

function titleKey(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const root = path.resolve(options.jobs)
const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
const candidates = []
for (const entry of entries.filter((item) => item.isDirectory())) {
  const docPath = path.join(root, entry.name, 'mirrordoc.json')
  try {
    const doc = JSON.parse(await readFile(docPath, 'utf8'))
    const source = buildOutlineSource(doc)
    if (source.entries.length < 3) continue
    candidates.push({
      jobId: entry.name,
      doc,
      source,
      title: doc?.meta?.title || entry.name,
    })
  } catch {
    // 非阅读作业目录。
  }
}

const byTitle = new Map()
for (const item of candidates) {
  const key = titleKey(item.title)
  const previous = byTitle.get(key)
  if (!previous || item.source.entries.length > previous.source.entries.length) {
    byTitle.set(key, item)
  }
}
const selected = [...byTitle.values()]
  .sort((a, b) => b.source.entries.length - a.source.entries.length)
  .slice(0, Math.max(1, options.max))

const results = []
for (const item of selected) {
  const prompt = buildSemanticOutlinePrompt(item.doc)
  let outline = null
  let warning = ''
  try {
    const raw = await chatJson({
      system: prompt.system,
      user: prompt.user,
      maxTokens: prompt.maxTokens,
    })
    outline = normalizeSemanticOutline(raw, item.doc)
    if (!outline) warning = '模型输出没有形成有效目录。'
  } catch (error) {
    warning = String(error?.message || error)
  }
  const effective = outline || fallbackOutline(item.doc)
  const items = (effective.groups || []).flatMap((group) => group.items || [])
  const polluted = items.filter((entry) =>
    /^(?:table|figure|algorithm|equation)\s*\d+|^references?$/i.test(
      [entry.label, entry.originalTitle, entry.summary].join(' '),
    ),
  )
  const excludedIds = items.filter((entry) => {
    const block = (item.doc.blocks || []).find((candidate) => candidate.id === entry.blockId)
    return block && !['heading'].includes(block.type) && entry.blockId !== '__meta_abstract'
  })
  const status =
    outline &&
    outline.coverage === 1 &&
    outline.groups.length >= 2 &&
    outline.groups.length <= 8 &&
    polluted.length === 0 &&
    excludedIds.length === 0
      ? 'pass'
      : warning
        ? 'fail'
        : 'partial'
  results.push({
    jobId: item.jobId,
    title: item.title,
    sourceCount: item.source.entries.length,
    groupCount: effective.groups?.length || 0,
    itemCount: items.length,
    coverage: outline?.coverage || 0,
    semantic: Boolean(outline?.semantic),
    polluted: polluted.map((entry) => entry.label),
    excludedIds: excludedIds.map((entry) => entry.blockId),
    status,
    warning,
    outline: effective,
  })
  console.error(`[b7-outline] ${results.length}/${selected.length} ${status} ${item.title}`)
}

const outputDir = path.resolve(options.out)
await mkdir(outputDir, { recursive: true })
const summary = {
  generatedAt: new Date().toISOString(),
  scope: '本地真实论文语义目录生成；块锚点可确定性校验，语义分组质量仍需人工复核。',
  cases: results.length,
  pass: results.filter((item) => item.status === 'pass').length,
  partial: results.filter((item) => item.status === 'partial').length,
  fail: results.filter((item) => item.status === 'fail').length,
  results,
}
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ...summary, results: undefined }, null, 2))
process.exitCode = summary.fail > 0 ? 1 : 0
