import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { evaluateRetrievalCases, relevantRank } from '../src/retrieval-eval.js'

test('检索指标：Top-1 / Top-3 / Recall@5 与 MRR', () => {
  const cases = [
    {
      id: 'top1',
      stratum: 'doi',
      queryKind: 'title',
      gold: { doi: '10.1000/a' },
      candidates: [{ doi: '10.1000/a' }, { doi: '10.1000/x' }],
    },
    {
      id: 'top3',
      stratum: 'doi',
      queryKind: 'author-year',
      gold: { title: 'Correct Paper' },
      candidates: [{ title: 'Noise' }, { title: 'Noise 2' }, { title: 'Correct Paper.' }],
    },
    {
      id: 'miss',
      stratum: 'title-only',
      queryKind: 'title',
      gold: { title: 'Missing Paper' },
      candidates: [{ title: 'Noise' }],
    },
  ]
  assert.equal(relevantRank(cases[1]), 3)
  const report = evaluateRetrievalCases(cases)
  assert.equal(report.scope, '分层回归金标集；不能外推为全球检索准确率')
  assert.equal(report.overall.cases, 3)
  assert.equal(report.overall.top1, 33.3)
  assert.equal(report.overall.top3, 66.7)
  assert.equal(report.overall.recall5, 66.7)
  assert.equal(report.overall.mrr, 0.444)
  assert.equal(report.byStratum.doi.top1, 50)
  assert.equal(report.byStratum['title-only'].recall5, 0)
  assert.equal(report.failures.length, 1)
})

test('检索指标：输出重复率、多路合并率与无结果率按案例统计', () => {
  const report = evaluateRetrievalCases([
    {
      id: 'duplicate',
      stratum: 'conference',
      queryKind: 'venue-year',
      gold: { doi: '10.1000/a' },
      candidates: [{ doi: '10.1000/a' }],
      retrieval: { duplicateCount: 2 },
    },
    {
      id: 'empty',
      stratum: 'conference',
      queryKind: 'venue-year',
      gold: { doi: '10.1000/b' },
      candidates: [],
    },
  ])
  assert.equal(report.overall.duplicateCandidateRate, 0)
  assert.equal(report.overall.multiRouteMergeRate, 50)
  assert.equal(report.overall.noResultRate, 50)
  assert.equal(report.failures.length, 1)
})

test('B5 金标种子：30～100 条、分层唯一、明确非全球准确率', async () => {
  const corpus = JSON.parse(
    await readFile(
      new URL('./fixtures/citation-retrieval-v1.json', import.meta.url),
      'utf8',
    ),
  )
  assert.ok(corpus.cases.length >= 30 && corpus.cases.length <= 100)
  assert.match(corpus.scope, /不代表全球检索准确率/)
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, corpus.cases.length)
  assert.ok(new Set(corpus.cases.map((item) => item.stratum)).size >= 3)
  assert.ok(new Set(corpus.cases.map((item) => item.queryKind)).size >= 4)
  assert.ok(corpus.cases.every((item) => item.gold?.doi || item.gold?.arxiv || item.gold?.title))
})
