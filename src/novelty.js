// B7 灵感模式查新工具。
//
// 只检索真实题录候选，不输出“绝对新颖”结论。模型根据候选自行判断
// 高度相似 / 部分相关 / 当前检索未发现，并保留 DOI/URL。

import { resolveLookup } from './lookup.js'

const MAX_QUERIES = 4
const MAX_RESULTS_PER_QUERY = 3

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeQueries(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(clean)
    .filter((query) => {
      const key = query.toLowerCase()
      if (query.length < 3 || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_QUERIES)
}

function noveltyLevel(candidates) {
  const top = candidates[0]
  if (!top) return 'current-search-not-found'
  if (top.matchScore >= 78 || top.confidence === 'high') return 'highly-related'
  if (top.matchScore >= 52 || top.confidence === 'medium') return 'partially-related'
  return 'current-search-not-found'
}

/**
 * 创建 `doraemon_search_novelty` 工具。
 */
export function createNoveltySearchTool({
  fetchImpl = fetch,
  resolveLookupImpl = resolveLookup,
  cache = new Map(),
} = {}) {
  return {
    name: 'doraemon_search_novelty',
    description:
      '灵感模式查新工具。B7 灵感模式提出可验证创意后，把每个创意的核心技术组合提取成 3–6 个简短英文检索查询，调用本工具一次。工具会通过 OpenAlex/Crossref/DataCite/arXiv 检索真实题录候选，返回标题、DOI、链接、年份、匹配分与判断依据。只能据此给出“高度相似 / 部分相关 / 当前检索未发现”，不得声称绝对新颖。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['queries'],
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUERIES,
          items: { type: 'string', minLength: 3, maxLength: 400 },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        queries: value?.queries?.length || 0,
        candidates: (value?.queries || []).reduce(
          (sum, item) => sum + (item.candidates?.length || 0),
          0,
        ),
        warnings: value?.warnings || [],
      }),
    },
    async execute(args) {
      const queries = normalizeQueries(args?.queries)
      if (queries.length === 0) {
        return {
          queries: [],
          warnings: ['没有可用的查新查询。'],
          caution: '当前未进行有效外部检索，不能据此判断新颖性。',
        }
      }
      const results = []
      const warnings = []
      for (const query of queries) {
        try {
          const result = await resolveLookupImpl(
            { query, title: query },
            {
              fetchImpl,
              cache,
              maxQueries: 1,
              searchQueries: [{ kind: 'title', text: query }],
            },
          )
          const candidates = (result.kind === 'candidates' ? result.candidates : [])
            .slice(0, MAX_RESULTS_PER_QUERY)
            .map((candidate) => ({
              title: candidate.title || '',
              doi: candidate.doi || '',
              arxiv: candidate.arxiv || '',
              year: Number(candidate.year) || 0,
              venue: candidate.venue || '',
              url: candidate.officialUrl || candidate.landingUrl || '',
              matchScore: Number(candidate.matchScore) || 0,
              confidence: candidate.confidence || 'low',
              reasons: (candidate.reasons || []).slice(0, 4),
            }))
          results.push({
            query,
            level: noveltyLevel(candidates),
            candidates,
            diagnostics: result.retrieval || {},
          })
          if (result.reason === 'retrieval-unavailable') {
            warnings.push(query + '：检索服务暂时不可用。')
          }
        } catch (error) {
          results.push({
            query,
            level: 'search-failed',
            candidates: [],
            diagnostics: {},
          })
          warnings.push(query + '：' + (error?.message || String(error)))
        }
      }
      return {
        queries: results,
        warnings,
        caution:
          '这些结果只代表当前检索范围。没有任何候选项不等于绝对新颖；“当前检索未发现”也不能替代系统综述或专业查新。',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '文献查新',
      kind: 'search',
      rawInput: (args?.queries || []).join(' · ').slice(0, 240),
    }),
    presentResult: (args, result) => {
      const count = (result?.queries || []).reduce(
        (sum, item) => sum + (item.candidates?.length || 0),
        0,
      )
      return {
        title: '查新 ' + (args?.queries?.length || 0) + ' 组 · ' + count + ' 个候选',
        content: [{ type: 'text', text: result?.caution || '检索完成。' }],
      }
    },
  }
}
