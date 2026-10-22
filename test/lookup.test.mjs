import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLookupQueries,
  citationPdfFromHtml,
  mergeLookupCandidates,
  normalizeDatacite,
  normalizeOpenAlex,
  parseArxivFeed,
  rankLookupCandidates,
  resolveLookup,
} from '../src/lookup.js'
import { routeRequest } from '../src/papers.js'

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.12948v1</id>
    <title>DeepSeek-R1: Incentivizing Reasoning Capability</title>
    <summary>A reasoning paper.</summary>
    <published>2025-01-20T00:00:00Z</published>
    <link href="https://arxiv.org/abs/2501.12948v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2501.12948v1" rel="related" type="application/pdf" title="pdf"/>
    <author><name>DeepSeek-AI</name></author>
  </entry>
</feed>`

const WORK = {
  title: 'Smart Sticker Ultra-Low-Power Shock Detection',
  doi: 'https://doi.org/10.3390/s22114003',
  publication_year: 2022,
  authorships: [{ author: { display_name: 'A. Author' } }],
  primary_location: {
    landing_page_url: 'https://doi.org/10.3390/s22114003',
    source: { display_name: 'Sensors' },
  },
  best_oa_location: {
    pdf_url: 'https://example.test/paper.pdf',
    license: 'cc-by',
    version: 'publishedVersion',
  },
  open_access: { is_oa: true, oa_status: 'gold' },
  abstract_inverted_index: { Hello: [0], world: [1] },
  locations: [],
}

const DATACITE = {
  data: {
    id: '10.48550/arxiv.2107.03374',
    attributes: {
      doi: '10.48550/arxiv.2107.03374',
      titles: [{ title: 'Evaluating Large Language Models Trained on Code' }],
      creators: [{ name: 'Chen, Mark' }, { name: 'Tworek, Jerry' }],
      publicationYear: 2021,
      publisher: 'arXiv',
      url: 'https://arxiv.org/abs/2107.03374',
      identifiers: [{ identifier: '2107.03374', identifierType: 'arXiv' }],
      descriptions: [{ descriptionType: 'Abstract', description: 'We introduce Codex.' }],
      types: { resourceTypeGeneral: 'Text' },
    },
  },
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer,
    url: 'https://example.test/final',
  }
}

test('lookup：arXiv feed 解析出版本、作者与 PDF', () => {
  const parsed = parseArxivFeed(ATOM)
  assert.equal(parsed.arxiv, '2501.12948v1')
  assert.equal(parsed.title, 'DeepSeek-R1: Incentivizing Reasoning Capability')
  assert.deepEqual(parsed.authors, ['DeepSeek-AI'])
  assert.match(parsed.pdfUrl, /arxiv\.org\/pdf/)
})

test('lookup：OpenAlex 元数据归一化与摘要倒排还原', () => {
  const metadata = normalizeOpenAlex(WORK)
  assert.equal(metadata.doi, '10.3390/s22114003')
  assert.equal(metadata.authors[0], 'A. Author')
  assert.equal(metadata.abstract, 'Hello world')
  assert.equal(metadata.pdfUrl, 'https://example.test/paper.pdf')
  assert.equal(metadata.license, 'cc-by')
  assert.equal(metadata.version, 'publishedVersion')
})

test('lookup：DataCite 元数据可恢复 arXiv 标题、作者与开放状态', () => {
  const metadata = normalizeDatacite(DATACITE)
  assert.equal(metadata.arxiv, '2107.03374')
  assert.equal(metadata.doi, '10.48550/arxiv.2107.03374')
  assert.match(metadata.title, /Evaluating Large Language Models/)
  assert.deepEqual(metadata.authors.slice(0, 2), ['Chen, Mark', 'Tworek, Jerry'])
  assert.equal(metadata.year, 2021)
  assert.equal(metadata.isOa, true)
})

test('lookup：严格正式版只返回元数据与官方链接', async () => {
  const result = await resolveLookup(
    { doi: '10.3390/s22114003', strictPublished: true },
    { fetchImpl: async () => response(WORK) },
  )
  assert.equal(result.kind, 'metadata-only')
  assert.equal(result.reason, 'strict-published')
  assert.equal(result.officialUrl, 'https://doi.org/10.3390/s22114003')
})

test('lookup：arXiv 精确查询走 HTML，DOI 可走 OA PDF', async () => {
  const arxiv = await resolveLookup(
    { arxiv: '2501.12948v1' },
    { fetchImpl: async () => response(ATOM) },
  )
  assert.equal(arxiv.kind, 'exact')
  assert.equal(arxiv.route, 'arxiv-html')
  const doi = await resolveLookup(
    { doi: '10.3390/s22114003' },
    { fetchImpl: async () => response(WORK) },
  )
  assert.equal(doi.kind, 'exact')
  assert.equal(doi.route, 'oa-pdf')
})

test('lookup：arXiv API 不可达时由 DataCite 接住精确编号', async () => {
  const result = await resolveLookup(
    { arxiv: '2107.03374' },
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://export.arxiv.org/api/query?id_list=')) {
          throw new Error('arxiv timeout')
        }
        return response(DATACITE)
      },
    },
  )
  assert.equal(result.kind, 'exact')
  assert.equal(result.metadata.arxiv, '2107.03374')
  assert.match(result.metadata.title, /Evaluating Large Language Models/)
  assert.equal(result.sourceUrl, 'https://arxiv.org/html/2107.03374')
})

test('lookup：标题查询返回候选列表', async () => {
  const result = await resolveLookup(
    { title: 'Smart Sticker Ultra-Low-Power Shock Detection' },
    { fetchImpl: async () => response({ results: [WORK] }), cache: false },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].doi, '10.3390/s22114003')
  assert.equal(result.candidates[0].isPrimary, true)
  assert.match(result.candidates[0].reasons.join('；'), /标题/)
  assert.equal(result.retrieval.metricsScope, 'current-query-only')
})

test('lookup：查询变体覆盖完整标题、去副标题、作者年份与刊物年份', () => {
  const variants = buildLookupQueries({
    title: 'A Long Paper Title: With a Subtitle',
    authors: 'Alice Smith; Bob Jones',
    venue: 'Sensors',
    year: '2022',
  })
  assert.ok(variants.some((entry) => entry.kind === 'title'))
  assert.ok(variants.some((entry) => entry.kind === 'title_without_subtitle'))
  assert.ok(variants.some((entry) => entry.kind === 'title_author_year'))
  assert.ok(variants.some((entry) => entry.text.includes('Alice Smith')))
})

test('lookup：多路结果按 DOI 去重并保留来源', () => {
  const merged = mergeLookupCandidates([
    { candidate: normalizeOpenAlex(WORK), route: 'openalex', queryKind: 'title' },
    {
      candidate: { ...normalizeOpenAlex(WORK), source: 'crossref', abstract: 'Longer abstract.' },
      route: 'crossref',
      queryKind: 'title_author_year',
    },
  ])
  assert.equal(merged.candidates.length, 1)
  assert.equal(merged.duplicateCount, 1)
  assert.deepEqual(
    merged.candidates[0]._provenance.map((entry) => entry.route),
    ['openalex', 'crossref'],
  )
})

test('lookup：Crossref 命中可以压过 OpenAlex 噪音，并解释排序依据', async () => {
  const correct = {
    DOI: '10.1000/correct',
    title: ['Deep Learning for Tabular Data: A Survey'],
    author: [{ given: 'Alice', family: 'Smith' }],
    published: { 'date-parts': [[2023]] },
    'container-title': ['ACM Computing Surveys'],
    abstract: 'A survey of tabular representation learning and retrieval.',
    type: 'journal-article',
  }
  const noise = {
    ...WORK,
    title: 'Deep Learning for Image Data',
    doi: 'https://doi.org/10.1000/noise',
    publication_year: 2020,
    authorships: [{ author: { display_name: 'Noise Author' } }],
  }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).startsWith('https://api.openalex.org/works?')) {
      return response({ results: [noise] })
    }
    if (String(url).startsWith('https://api.crossref.org/works?')) {
      return response({ message: { items: [correct] } })
    }
    return response(ATOM, 200)
  }
  const result = await resolveLookup(
    {
      title: 'Deep Learning for Tabular Data: A Survey',
      authors: 'Alice Smith',
      venue: 'ACM Computing Surveys',
      year: '2023',
      fromReference: true,
    },
    { fetchImpl, cache: false },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates[0].doi, '10.1000/correct')
  assert.equal(result.candidates[0].isPrimary, true)
  assert.ok(result.candidates[0].matchScore > result.candidates[1].matchScore)
  assert.match(result.candidates[0].reasons.join('；'), /作者|年份|刊物|参考文献/)
  assert.ok(result.retrieval.routes.some((entry) => entry.route === 'crossref' && entry.status === 'ok'))
  assert.ok(calls.length >= 3)
})

test('lookup：单路失败时保留其他路结果并记录诊断', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://api.openalex.org/works?')) {
      throw new Error('OpenAlex timeout')
    }
    if (String(url).startsWith('https://api.crossref.org/works?')) {
      return response({
        message: {
          items: [
            {
              DOI: '10.1000/resilient',
              title: ['Resilient Retrieval'],
              author: [{ given: 'A', family: 'Author' }],
              published: { 'date-parts': [[2021]] },
              'container-title': ['Journal'],
            },
          ],
        },
      })
    }
    return response(ATOM, 200)
  }
  const result = await resolveLookup(
    { title: 'Resilient Retrieval', year: '2021' },
    { fetchImpl, cache: false },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates[0].doi, '10.1000/resilient')
  assert.ok(result.retrieval.routes.some((entry) => entry.status === 'failed'))
})

test('lookup：标题查询可经 DataCite 召回 arXiv 预印本', async () => {
  const result = await resolveLookup(
    { title: 'Evaluating Large Language Models Trained on Code', year: '2021' },
    {
      cache: false,
      routeHealth: new Map(),
      fetchImpl: async (url) => {
        const text = String(url)
        if (text.startsWith('https://api.openalex.org/works?')) return response({}, 429)
        if (text.startsWith('https://api.crossref.org/works?')) {
          return response({ message: { items: [] } })
        }
        if (text.startsWith('https://api.datacite.org/dois?')) {
          return response({ data: [DATACITE.data] })
        }
        throw new Error('arxiv timeout')
      },
    },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates[0].arxiv, '2107.03374')
  assert.ok(result.candidates[0].retrievalRoutes.includes('datacite'))
})

test('lookup：评测可固定单一查询变体，避免分片指标串线', async () => {
  const calls = []
  const result = await resolveLookup(
    {
      title: 'Deep Learning for Tabular Data: A Survey',
      authors: 'Alice Smith',
      venue: 'ACM Computing Surveys',
      year: '2023',
    },
    {
      searchQueries: [{ kind: 'author_venue_year', text: 'Alice Smith ACM Computing Surveys 2023' }],
      cache: false,
      fetchImpl: async (url) => {
        calls.push(String(url))
        return response(
          String(url).includes('crossref')
            ? { message: { items: [] } }
            : { results: [] },
        )
      },
    },
  )
  assert.equal(result.kind, 'none')
  assert.equal(result.retrieval.queryVariants.length, 1)
  assert.equal(result.retrieval.queryVariants[0].kind, 'author_venue_year')
  assert.equal(calls.length, 2)
})

test('lookup：429 后进入冷却，后续请求不再反复撞同一路', async () => {
  const routeHealth = new Map()
  let openAlexCalls = 0
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.startsWith('https://api.openalex.org/works?')) {
      openAlexCalls += 1
      return response({ error: 'rate limit' }, 429)
    }
    if (text.startsWith('https://api.crossref.org/works?')) {
      return response({
        message: {
          items: [
            {
              DOI: '10.1000/cooled',
              title: ['Cooling Down'],
              author: [{ given: 'A', family: 'Author' }],
              published: { 'date-parts': [[2024]] },
              'container-title': ['Journal'],
            },
          ],
        },
      })
    }
    return response(ATOM, 200)
  }
  const fields = { title: 'Cooling Down', maxQueries: 1 }
  const first = await resolveLookup(fields, { fetchImpl, cache: false, routeHealth })
  const second = await resolveLookup(fields, { fetchImpl, cache: false, routeHealth })
  assert.equal(first.kind, 'candidates')
  assert.equal(second.kind, 'candidates')
  assert.equal(openAlexCalls, 1)
  assert.ok(second.retrieval.routes.some((entry) => entry.route === 'openalex' && entry.status === 'skipped'))
})

test('lookup：候选最多返回 12 条，保留总数用于诊断', async () => {
  const works = Array.from({ length: 15 }, (_, index) => ({
    ...WORK,
    title: 'Candidate ' + index,
    doi: 'https://doi.org/10.1000/candidate-' + index,
  }))
  const result = await resolveLookup(
    { title: 'Candidate' },
    {
      cache: false,
      routeHealth: new Map(),
      fetchImpl: async (url) =>
        String(url).includes('crossref')
          ? response({ message: { items: [] } })
          : response({ results: works }),
    },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates.length, 12)
  assert.ok(result.retrieval.uniqueCount >= 12)
  assert.equal(result.retrieval.returnedCount, 12)
})

test('lookup：前两项分数接近时标记为并列候选，不伪装唯一答案', () => {
  const candidates = rankLookupCandidates(
    [
      { title: 'Deep Learning for Tabular Data: A Survey', authors: ['Alice Smith'], year: 2023, venue: 'Survey Journal' },
      { title: 'Deep Learning for Tabular Data: A Survey.', authors: ['Alice Smith'], year: 2023, venue: 'Survey Journal' },
    ],
    { title: 'Deep Learning for Tabular Data: A Survey', authors: 'Alice Smith', year: '2023', venue: 'Survey Journal' },
  )
  assert.equal(candidates[0].isPrimary, true)
  assert.equal(candidates[0].isAmbiguous, true)
  assert.equal(candidates[1].isAmbiguous, true)
  assert.match(candidates[0].ambiguityReason, /接近/)
})

test('lookup：OA landing page 的 citation_pdf_url 能被识别', () => {
  const pdf = citationPdfFromHtml(
    '<meta name="citation_pdf_url" content="/article/file.pdf">',
    'https://journal.example/article/1',
  )
  assert.equal(pdf, 'https://journal.example/article/file.pdf')
})

test('lookup 路由：resolve 与 fetch', () => {
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/lookup/resolve'), { type: 'lookup-resolve' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/lookup/fetch'), { type: 'lookup-fetch' })
})
