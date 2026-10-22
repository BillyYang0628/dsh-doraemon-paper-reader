#!/usr/bin/env node
// P3 知识层评估：真实 DSH 知识索引、固定查询集、引用图与阅读档案。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const out = { out: '工具/gen/P3-20261022/knowledge-eval' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') out.url = argv[++index]
    else if (argv[index] === '--out') out.out = argv[++index]
    else throw new Error('未知参数：' + argv[index])
  }
  if (!out.url) throw new Error('必须给 --url')
  return out
}

const args = parseArgs(process.argv.slice(2))
const parsed = new URL(args.url)
const token = parsed.searchParams.get('token') || ''
const baseUrl = parsed.origin + '/'
const outDir = path.resolve(args.out)
await mkdir(outDir, { recursive: true })

async function jsonRequest(pathname, body) {
  const url = new URL(pathname, baseUrl)
  if (token) url.searchParams.set('token', token)
  const started = performance.now()
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || response.statusText)
  return { payload, durationMs: Math.round(performance.now() - started) }
}

const queries = [
  'MobileViT',
  'plant disease edge device',
  'supply chain shock detection',
  'antimicrobial resistance',
  'research data citation rate',
  'IoT sensor actuator',
  'tabular embeddings',
]

const status = await jsonRequest('/doraemon-paper-reader/api/knowledge')
const profile = await jsonRequest('/doraemon-paper-reader/api/knowledge/profile')
const results = []
for (const query of queries) {
  const run = await jsonRequest('/doraemon-paper-reader/api/knowledge/search', {
    query,
    limit: 20,
  })
  const items = Array.isArray(run.payload.results) ? run.payload.results : []
  results.push({
    query,
    durationMs: run.durationMs,
    count: items.length,
    paperGroups: run.payload.groups?.length || 0,
    anchored: items.filter((item) => item.blockId).length,
    sourceTypes: [...new Set(items.map((item) => item.sourceType))],
  })
}

const papers = profile.payload.papers || []
const graphTarget = papers.find((paper) => /MobileViT/i.test(paper.title)) || papers[0]
let graph = null
if (graphTarget) {
  const graphRun = await jsonRequest(
    '/doraemon-paper-reader/api/jobs/' + encodeURIComponent(graphTarget.jobId) + '/citation-graph',
  )
  graph = {
    jobId: graphTarget.jobId,
    title: graphTarget.title,
    durationMs: graphRun.durationMs,
    ...graphRun.payload.coverage,
    edges: graphRun.payload.edges?.length || 0,
  }
}

const checks = {
  indexHasEntries: (status.payload.stats?.total || 0) > 0,
  allQueriesReturnResults: results.every((item) => item.count > 0),
  allResultsAnchored: results.every((item) => item.anchored === item.count),
  graphAvailable: Boolean(graph && graph.edges > 0),
  profileAvailable: Array.isArray(profile.payload.papers),
}
const report = {
  generatedAt: new Date().toISOString(),
  url: baseUrl,
  status: status.payload,
  readProfile: {
    papers: profile.payload.papers?.length || 0,
    totalReadingSeconds: profile.payload.totalReadingSeconds || 0,
    pendingAnnotations: profile.payload.pendingAnnotations || 0,
    reviewPending: profile.payload.reviewPending || 0,
  },
  queries: results,
  graph,
  checks,
}
report.ok = Object.values(checks).every(Boolean)
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ out: outDir, ok: report.ok, checks, queries: results, graph }, null, 2))
if (!report.ok) process.exitCode = 1
