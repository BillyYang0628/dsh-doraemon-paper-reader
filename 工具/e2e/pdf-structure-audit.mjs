#!/usr/bin/env node
// B0：对单个 job 的 MirrorDoc 做结构基线审计。
// 不修解析结果，只输出可疑 heading、编号步骤段落、表格完整性和分隔符能力缺口。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--job') out.job = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--job-root') out.jobRoot = argv[++i]
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.job) throw new Error('必须给 --job')
const jobRoot = path.resolve(
  args.jobRoot ?? path.join(process.env.DSH_HOME ?? 'D:/DSH/home', 'doraemon-paper-reader', 'jobs'),
)
const jobDir = path.join(jobRoot, args.job)
const outDir = path.resolve(args.out ?? '工具/gen/B0-20261021/structure-' + args.job)
const doc = JSON.parse(await readFile(path.join(jobDir, 'mirrordoc.json'), 'utf8'))
const layoutPath = path.join(jobDir, 'layout-report.json')
let layout = null
try {
  layout = JSON.parse(await readFile(layoutPath, 'utf8'))
} catch {
  // Layout report is optional for HTML jobs.
}

const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
const byType = {}
for (const block of blocks) byType[block.type || 'unknown'] = (byType[block.type || 'unknown'] || 0) + 1

const suspiciousHeadings = blocks
  .filter((block) => block.type === 'heading')
  .map((block) => ({
    id: block.id,
    page: block.page,
    text: String(block.text || '').trim(),
  }))
  .filter((block) => {
    if (/^(begin|end)$/i.test(block.text)) return true
    if (/^(algorithm|figure|table)\s*\d+/i.test(block.text)) return true
    return false
  })

const numberedParagraphs = blocks
  .filter((block) => block.type === 'paragraph')
  .map((block) => {
    const text = String(block.text || '')
    const hasSequentialSteps = /(?:^|\s)1[:.]\s+[\s\S]+(?:^|\s)2[:.]\s+[\s\S]+(?:^|\s)3[:.]\s+/i.test(text)
    if (!hasSequentialSteps) return null
    const numbered = [...text.matchAll(/(?:^|\s)(\d{1,2})[:.]\s*/g)].map((match) => Number(match[1]))
    const unique = [...new Set(numbered)]
    return { id: block.id, page: block.page, steps: unique.length, first: unique.slice(0, 5), text: text.slice(0, 240) }
  })
  .filter((block) => block && block.steps >= 3)

const tables = blocks
  .filter((block) => block.type === 'table')
  .map((block) => {
    const tableText = String(block.tableText || block.text || '')
    return {
      id: block.id,
      page: block.page,
      label: block.label || '',
      caption: String(block.caption || '').slice(0, 220),
      chars: tableText.length,
      explicitNewlines: (tableText.match(/\n/g) || []).length,
      hasAsset: Boolean(block.asset),
      rotatedPage: Boolean(block.rotatedPage),
      tableText: tableText.slice(0, 500),
    }
  })

const separatorBlocks = blocks.filter((block) => ['separator', 'divider', 'rule', 'horizontal-rule'].includes(block.type))
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  job: args.job,
  title: doc.meta?.title || '',
  mirrorKind: doc.provenance?.mirrorKind || '',
  pages: Number(doc.meta?.pageCount) || 0,
  blocks: blocks.length,
  byType,
  coverage: doc.coverage || null,
  layoutWarnings: layout?.warnings || [],
  findings: {
    suspiciousHeadings,
    numberedParagraphs,
    tables,
    separatorSupport: {
      blocks: separatorBlocks.length,
      supported: separatorBlocks.length > 0,
      note: 'A zero count can mean the PDF has no separators or that separators are not represented; inspect source pages before treating it as a parser failure.',
    },
    tableSuspicionCount: tables.filter((table) => table.chars > 500 && table.explicitNewlines === 0).length,
  },
}

await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

const lines = [
  '# B0 PDF Structure Audit',
  '',
  '- Job: `' + args.job + '`',
  '- Title: ' + report.title,
  '- Mirror kind: `' + report.mirrorKind + '`',
  '- Pages: ' + report.pages,
  '- Blocks: ' + report.blocks,
  '- Block types: `' + JSON.stringify(byType) + '`',
  '- Separator blocks: ' + separatorBlocks.length,
  '',
  '## Suspicious headings',
  '',
  ...(suspiciousHeadings.length
    ? suspiciousHeadings.map((item) => `- p.${item.page} \`${item.id}\`: ${item.text}`)
    : ['- None detected']),
  '',
  '## Numbered-step paragraphs',
  '',
  ...(numberedParagraphs.length
    ? numberedParagraphs.map(
        (item) => `- p.${item.page} \`${item.id}\`: ${item.steps} steps (${item.first.join(', ')}): ${item.text}`,
      )
    : ['- None detected']),
  '',
  '## Tables',
  '',
  ...(tables.length
    ? tables.map(
        (item) =>
          `- p.${item.page} ${item.label || item.id}: ${item.chars} chars, ${item.explicitNewlines} explicit newlines, asset=${item.hasAsset}, rotated=${item.rotatedPage}`,
      )
    : ['- None detected']),
]
await writeFile(path.join(outDir, 'report.md'), lines.join('\n') + '\n', 'utf8')

console.log(JSON.stringify({ out: outDir, suspiciousHeadings: suspiciousHeadings.length, numberedParagraphs: numberedParagraphs.length, tables: tables.length }, null, 2))
