import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNoveltySearchTool } from '../src/novelty.js'

test('B7 查新工具：限制查询数、返回真实候选与谨慎等级', async () => {
  const calls = []
  const tool = createNoveltySearchTool({
    resolveLookupImpl: async (fields, options) => {
      calls.push({ fields, options })
      return {
        kind: 'candidates',
        candidates: [
          {
            title: 'Adaptive Patch Routing for Lightweight Vision Transformers',
            doi: '10.1000/adaptive',
            year: 2025,
            venue: 'CVPR',
            officialUrl: 'https://doi.org/10.1000/adaptive',
            matchScore: 84,
            confidence: 'high',
            reasons: ['标题高度相似'],
          },
        ],
        retrieval: { routes: [{ route: 'crossref', status: 'ok' }] },
      }
    },
  })
  const result = await tool.execute({
    queries: ['adaptive patch routing lightweight vision transformer', 'same', 'same', 'query 4', 'query 5'],
  })
  assert.equal(calls.length, 4)
  assert.equal(result.queries.length, 4)
  assert.equal(result.queries[0].level, 'highly-related')
  assert.equal(result.queries[0].candidates[0].doi, '10.1000/adaptive')
  assert.match(result.caution, /不等于绝对新颖/)
})

test('B7 查新工具：无候选时只返回当前检索未发现', async () => {
  const tool = createNoveltySearchTool({
    resolveLookupImpl: async () => ({
      kind: 'none',
      reason: 'no-match',
      retrieval: { routes: [] },
    }),
  })
  const result = await tool.execute({ queries: ['novel query'] })
  assert.equal(result.queries[0].level, 'current-search-not-found')
  assert.match(result.caution, /不能替代系统综述/)
})

test('B7 查新工具：单路异常转成 search-failed，不伪造候选', async () => {
  const tool = createNoveltySearchTool({
    resolveLookupImpl: async () => {
      throw new Error('temporary failure')
    },
  })
  const result = await tool.execute({ queries: ['failure query'] })
  assert.equal(result.queries[0].level, 'search-failed')
  assert.equal(result.queries[0].candidates.length, 0)
  assert.match(result.warnings.join('；'), /temporary failure/)
})
