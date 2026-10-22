#!/usr/bin/env node
// 评估引用候选多路召回与排序。
//
// 默认离线读取 fixture 中的候选快照；--live 才会访问 OpenAlex / Crossref / arXiv。
// 失败样本可通过 --failure-out 追加为后续回归种子。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveLookup } from '../../src/lookup.js'
import { evaluateRetrievalCases } from '../../src/retrieval-eval.js'

const args = process.argv.slice(2)
const options = {
  corpus: 'test/fixtures/citation-retrieval-v1.json',
  out: '',
  live: false,
  maxCases: 0,
  only: '',
  failureOut: '',
  concurrency: 2,
  delayMs: 800,
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--corpus') options.corpus = args[++index]
  else if (args[index] === '--out') options.out = args[++index]
  else if (args[index] === '--live') options.live = true
  else if (args[index] === '--max-cases') options.maxCases = Number(args[++index])
  else if (args[index] === '--only') options.only = args[++index]
  else if (args[index] === '--failure-out') options.failureOut = args[++index]
  else if (args[index] === '--concurrency') options.concurrency = Number(args[++index])
  else if (args[index] === '--delay-ms') options.delayMs = Number(args[++index])
  else throw new Error('未知参数：' + args[index])
}

const corpus = JSON.parse(await readFile(path.resolve(options.corpus), 'utf8'))
let cases = Array.isArray(corpus?.cases) ? corpus.cases : []
if (options.only) cases = cases.filter((item) => item.id === options.only)
if (options.maxCases > 0 && cases.length > options.maxCases) {
  const groups = new Map()
  for (const item of cases) {
    const key = item.stratum || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const selected = []
  const cursors = new Map([...groups.keys()].map((key) => [key, 0]))
  while (selected.length < options.maxCases) {
    let progressed = false
    for (const key of groups.keys()) {
      const index = cursors.get(key)
      const group = groups.get(key)
      if (index < group.length && selected.length < options.maxCases) {
        selected.push(group[index])
        cursors.set(key, index + 1)
        progressed = true
      }
    }
    if (!progressed) break
  }
  cases = selected
}

async function runCase(item) {
  if (!options.live) return item
  if (options.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs))
  }
  const fields = {
    query: item.query?.text || item.query?.query || item.gold?.title || '',
    title: item.gold?.title || '',
    doi: item.queryKind === 'doi-exact' ? item.gold?.doi || '' : '',
    arxiv: item.queryKind === 'arxiv-exact' ? item.gold?.arxiv || '' : '',
    referenceText: item.source?.referenceText || '',
    citationContext: item.citationContext || '',
    fromReference: true,
  }
  try {
    const result = await resolveLookup(fields, {
      fetchImpl: fetchWithRetry,
      existing: async () => '',
      searchQueries:
        item.query?.text &&
        !['doi-exact', 'arxiv-exact'].includes(item.queryKind)
          ? [item.query]
          : null,
    })
    const resolvedCandidate =
      result.metadata && ['exact', 'existing', 'metadata-only'].includes(result.kind)
        ? [
            {
              ...result.metadata,
              retrievalRoutes: [result.route || result.kind],
              matchScore: 100,
              confidence: 'high',
              confidenceLabel: '高',
              reasons: ['命中参考文献中的原始标识符'],
            },
          ]
        : []
    return {
      ...item,
      candidates:
        result.kind === 'candidates' ? result.candidates : resolvedCandidate,
      retrieval: result.retrieval || {
        routes: [],
        uniqueCount: 0,
        message: result.message || '',
        reason: result.reason || '',
      },
    }
  } catch (error) {
    return {
      ...item,
      candidates: [],
      retrieval: {
        routes: [],
        uniqueCount: 0,
        error: String(error?.message || error),
      },
    }
  }
}

async function fetchWithRetry(url, init = {}) {
  let lastResponse
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastResponse = await fetch(url, init)
    if (lastResponse.status !== 429 && lastResponse.status !== 503) return lastResponse
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return lastResponse
}

const results = new Array(cases.length)
let cursor = 0
async function worker() {
  while (cursor < cases.length) {
    const index = cursor
    cursor += 1
    results[index] = await runCase(cases[index])
    console.error(`[citation-eval] ${index + 1}/${cases.length} ${cases[index].queryKind}`)
  }
}
await Promise.all(
  Array.from(
    { length: Math.max(1, Math.min(4, options.live ? 1 : options.concurrency || 2)) },
    () => worker(),
  ),
)

const report = {
  generatedAt: new Date().toISOString(),
  mode: options.live ? 'live' : 'offline-snapshot',
  corpus: {
    version: corpus.version,
    scope: corpus.scope,
    limitations: corpus.limitations || [],
  },
  metrics: evaluateRetrievalCases(results),
}

if (options.out) {
  const outputPath = path.resolve(options.out)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
}

if (options.failureOut && report.metrics.failures.length > 0) {
  const failurePath = path.resolve(options.failureOut)
  let existing = []
  try {
    existing = JSON.parse(await readFile(failurePath, 'utf8'))
  } catch {
    existing = []
  }
  const byId = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.id, item]))
  for (const failure of report.metrics.failures) {
    byId.set(failure.id, {
      ...failure,
      recordedAt: new Date().toISOString(),
      reviewStatus: 'needs-review',
    })
  }
  await mkdir(path.dirname(failurePath), { recursive: true })
  await writeFile(failurePath, JSON.stringify([...byId.values()], null, 2) + '\n', 'utf8')
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.metrics.overall.recall5 === 0 && results.length > 0 ? 1 : 0
