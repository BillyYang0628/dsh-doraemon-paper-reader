import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  citationPdfFromHtml,
  normalizeOpenAlex,
  parseArxivFeed,
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

test('lookup：标题查询返回候选列表', async () => {
  const result = await resolveLookup(
    { title: 'Smart Sticker' },
    { fetchImpl: async () => response({ results: [WORK] }) },
  )
  assert.equal(result.kind, 'candidates')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].doi, '10.3390/s22114003')
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
