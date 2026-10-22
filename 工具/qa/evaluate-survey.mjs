#!/usr/bin/env node
// B9 多篇综述评估：从本地真实论文自动构造正例、负例和三篇缺口任务；
// 可选 --live 调用真实 DSH API 生成对照表和证据报告。

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { assessSurveyCompatibility } from '../../src/compare.js'
import { createPaperDigestReader } from '../../src/digest.js'

function parseArgs(argv) {
  const out = {
    jobsRoot: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'doraemon-paper-reader', 'jobs'),
    out: '工具/gen/B9-20261022/survey-eval',
    live: false,
    maxPapers: 40,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--jobs-root') out.jobsRoot = argv[++index]
    else if (arg === '--out') out.out = argv[++index]
    else if (arg === '--url') out.url = argv[++index]
    else if (arg === '--live') out.live = true
    else if (arg === '--max-papers') out.maxPapers = Number(argv[++index])
    else throw new Error('未知参数：' + arg)
  }
  return out
}

function pairScore(left, right) {
  const result = assessSurveyCompatibility([left, right], 'method')
  return result
}

function tripleScore(digests) {
  const result = assessSurveyCompatibility(digests, 'gap')
  return result
}

function combinations(items, size) {
  const output = []
  const visit = (start, picked) => {
    if (picked.length === size) {
      output.push([...picked])
      return
    }
    for (let index = start; index < items.length; index += 1) {
      picked.push(items[index])
      visit(index + 1, picked)
      picked.pop()
    }
  }
  visit(0, [])
  return output
}

function rankPair(left, right) {
  const preflight = pairScore(left, right)
  return {
    jobIds: [left.jobId, right.jobId],
    titles: [left.title, right.title],
    score: preflight.score,
    status: preflight.status,
    canProceed: preflight.canProceed,
    sharedTerms: preflight.sharedTerms,
    duplicatePairs: preflight.duplicatePairs,
    preflight,
  }
}

async function readLocalDigests(jobsRoot, maxPapers) {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])
  const ids = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await readdir(path.join(jobsRoot, entry.name))
      const { readDigests } = createPaperDigestReader({ jobsRoot })
      const [digest] = await readDigests([entry.name])
      if (digest?.title) ids.push(digest)
    } catch {
      // 跳过半成品与回收站外目录。
    }
    if (ids.length >= maxPapers) break
  }
  return ids
}

async function callApi(baseUrl, pathname, body, token) {
  const url = new URL(pathname, baseUrl)
  if (token) url.searchParams.set('token', token)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || response.statusText)
  return payload
}

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(args.out)
await mkdir(outDir, { recursive: true })

const digests = await readLocalDigests(args.jobsRoot, args.maxPapers)
if (digests.length < 2) throw new Error('本地可读论文少于 2 篇，无法构造 B9 任务集')

const pairRanks = []
for (let left = 0; left < digests.length; left += 1) {
  for (let right = left + 1; right < digests.length; right += 1) {
    pairRanks.push(rankPair(digests[left], digests[right]))
  }
}
pairRanks.sort((left, right) => right.score - left.score)
const positive =
  pairRanks.find((pair) => pair.canProceed && pair.status === 'comparable') ||
  pairRanks.find((pair) => pair.canProceed) ||
  pairRanks[0]
const negative =
  pairRanks.find((pair) => pair.duplicatePairs.length > 0) ||
  [...pairRanks].sort((left, right) => left.score - right.score).find((pair) => !pair.canProceed) ||
  [...pairRanks].sort((left, right) => left.score - right.score)[0]

const triples = []
for (const combination of combinations(digests.slice(0, Math.min(digests.length, 16)), 3)) {
  const preflight = tripleScore(combination)
  triples.push({
    jobIds: combination.map((digest) => digest.jobId),
    titles: combination.map((digest) => digest.title),
    score: preflight.score,
    status: preflight.status,
    canProceed: preflight.canProceed,
    sharedTerms: preflight.sharedTerms,
    preflight,
  })
}
triples.sort((left, right) => right.score - left.score)
const gapTask =
  triples.find((task) => task.canProceed && task.preflight.duplicatePairs.length === 0) ||
  triples.find((task) => task.canProceed) ||
  triples[0] ||
  null

const checks = {
  positiveAccepted: Boolean(positive?.canProceed),
  negativeRejected: Boolean(negative && !negative.canProceed),
  negativeIsVersionOrLowSimilarity:
    Boolean(negative?.duplicatePairs.length) || Boolean(negative && negative.score < 0.015),
  gapHasThreePapers: Boolean(gapTask && gapTask.jobIds.length === 3),
}

const report = {
  generatedAt: new Date().toISOString(),
  jobsRoot: args.jobsRoot,
  corpus: {
    readablePapers: digests.length,
    pairs: pairRanks.length,
    triples: triples.length,
  },
  tasks: {
    methodPositive: positive,
    negative,
    gapTask,
  },
  checks,
  live: null,
}

if (args.live) {
  if (!args.url) throw new Error('--live 必须给 --url')
  const parsed = new URL(args.url)
  const token = parsed.searchParams.get('token') || ''
  const baseUrl = parsed.origin + '/'
  const table = await callApi(
    baseUrl,
    '/doraemon-paper-reader/api/compare/table',
    { jobIds: positive.jobIds, surveyMode: 'method' },
    token,
  )
  const reportPayload =
    table.kind === 'survey-table' && table.table
      ? await callApi(
          baseUrl,
          '/doraemon-paper-reader/api/compare/survey-report',
          {
            jobIds: positive.jobIds,
            surveyMode: 'method',
            table: table.table,
          },
          token,
        )
      : null
  const negativeTable = negative
    ? await callApi(
        baseUrl,
        '/doraemon-paper-reader/api/compare/table',
        { jobIds: negative.jobIds, surveyMode: 'method' },
        token,
      )
    : null
  const gapTable =
    gapTask && gapTask.canProceed
      ? await callApi(
          baseUrl,
          '/doraemon-paper-reader/api/compare/table',
          { jobIds: gapTask.jobIds, surveyMode: 'gap' },
          token,
        )
      : null
  report.live = {
    positiveKind: table.kind || '',
    tableAnchorRate: table.table?.stats?.anchorRate || 0,
    groundedRelations: table.table?.stats?.relations || 0,
    groundedGaps: table.table?.stats?.gapsGrounded || 0,
    inferenceGaps: table.table?.stats?.gapsInference || 0,
    reportStats: reportPayload?.stats || null,
    negativeKind: negativeTable?.kind || '',
    gapKind: gapTable?.kind || '',
    gapStats: gapTable?.table?.stats || null,
    inferenceGaps: (gapTable?.table?.gaps || [])
      .filter((gap) => gap.kind === 'model-inference')
      .map((gap) => ({ text: gap.text, nextStep: gap.nextStep, noveltyCheck: gap.noveltyCheck })),
  }
  checks.liveTableGenerated = table.kind === 'survey-table' && Boolean(table.table)
  checks.liveReportGenerated = Boolean(reportPayload?.report)
  checks.liveReportNoUnsourcedFacts = reportPayload?.stats?.unsourcedFacts === 0
  checks.liveNegativeRejected = negativeTable?.kind === 'not-comparable'
  checks.liveGapHasAnchoredTable =
    gapTable?.kind === 'survey-table' && (gapTable.table?.stats?.grounded || 0) > 0
  checks.liveInferenceGapsActionable =
    (report.live.inferenceGaps || []).length === 0 ||
    report.live.inferenceGaps.every((gap) => Boolean(gap.nextStep) && gap.noveltyCheck === 'not-run')
}

report.ok = Object.values(checks).every(Boolean)
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ out: outDir, ok: report.ok, checks, corpus: report.corpus, live: report.live }, null, 2))
if (!report.ok) process.exitCode = 1
