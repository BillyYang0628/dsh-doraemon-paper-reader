// 论文查询与来源选择（B 的纯逻辑层）。
//
// 这里不碰文件、不启动 Python；只做：
//   - DOI / arXiv / 标题+作者+刊物+年份 → 规范化查询
//   - OpenAlex / arXiv / Crossref → 统一 metadata
//   - 合法来源阶梯：arXiv HTML → arXiv PDF → OA PDF → metadata-only
//   - 严格正式版时只给官方链接，不擅自取预印本正文

import { normalizeArxiv, normalizeDoi } from './identifiers.js'

const ARXIV_API = 'https://export.arxiv.org/api/query?id_list='
const ARXIV_SEARCH_API = 'https://export.arxiv.org/api/query?'
const OPENALEX_API = 'https://api.openalex.org'
const CROSSREF_API = 'https://api.crossref.org/works/'
const CROSSREF_SEARCH_API = 'https://api.crossref.org/works?'
const DATACITE_API = 'https://api.datacite.org'
const USER_AGENT = 'dsh-doraemon-paper-reader/0.1.0 (local research tool)'
const FETCH_TIMEOUT_MS = 45000
const SEARCH_TIMEOUT_MS = 8000
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const SEARCH_CACHE_LIMIT = 200
const ROUTE_FAILURE_COOLDOWN_MS = 2 * 60 * 1000
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000
const DEFAULT_SEARCH_CACHE = new Map()
const DEFAULT_ROUTE_HEALTH = new Map()
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'using',
  'with',
])

/** 去掉 OpenAlex/Crossref 的 URL 外壳，只留 DOI。 */
function bareDoi(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase() || ''
}

/** 从 `10.48550/arXiv.2501.12948` 这类 DataCite DOI 里取 arXiv ID。 */
export function arxivFromDoi(value) {
  const doi = bareDoi(value)
  const match = doi.match(/^10\.48550\/arxiv\.(.+)$/i)
  return match ? normalizeArxiv(match[1]) : undefined
}

/** 从任意 URL 里取 arXiv ID。 */
export function arxivFromUrl(value) {
  const match = String(value ?? '').match(/arxiv\.org\/(?:abs|pdf|html)\/([^/?#]+)/i)
  return match ? normalizeArxiv(match[1]) : undefined
}

/** 把可选的多个输入框拼成一次文本查询。 */
export function buildSearchText(fields = {}) {
  return [fields.query, fields.title, fields.authors, fields.venue, fields.year]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

function uniqueBy(items, keyOf) {
  const seen = new Set()
  return items.filter((item) => {
    const key = keyOf(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function queryKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstAuthor(value) {
  return String(value ?? '')
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .find(Boolean) || ''
}

function removeSubtitle(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const head = text.split(/\s*[:：]\s*/)[0].trim()
  return head.split(/\s+/).length >= 3 ? head : ''
}

/**
 * 生成受控的查询变体。调用方只取前几个，避免向多个学术 API 发请求风暴。
 */
export function buildLookupQueries(fields = {}) {
  const title = cleanText(fields.title)
  const authors = cleanText(fields.authors)
  const venue = cleanText(fields.venue)
  const year = cleanText(fields.year)
  const query = cleanText(fields.query)
  const shortTitle = removeSubtitle(title)
  const author = firstAuthor(authors)
  const variants = [
    { kind: 'full', text: buildSearchText(fields) },
    title ? { kind: 'title', text: title } : null,
    shortTitle ? { kind: 'title_without_subtitle', text: shortTitle } : null,
    title && author && year
      ? { kind: 'title_author_year', text: [title, author, year].filter(Boolean).join(' ') }
      : null,
    title && (venue || year)
      ? { kind: 'title_venue_year', text: [title, venue, year].filter(Boolean).join(' ') }
      : null,
    author || venue || year
      ? {
          kind: 'author_venue_year',
          text: [author || authors, venue, year].filter(Boolean).join(' '),
        }
      : null,
  ].filter(Boolean)
  return uniqueBy(variants, (variant) => queryKey(variant.text))
}

/** 清掉 HTML 标签、压缩空白；只用于元数据字段。 */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** OpenAlex 的摘要以倒排索引保存，这里还原成正常文本。 */
function rebuildAbstract(index) {
  if (!index || typeof index !== 'object') return ''
  const words = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of Array.isArray(positions) ? positions : []) {
      words[Number(position)] = word
    }
  }
  return words.filter(Boolean).join(' ')
}

/** OpenAlex work → 统一 metadata。 */
export function normalizeOpenAlex(work) {
  if (!work || typeof work !== 'object') return null
  const doi = bareDoi(work.doi)
  const authors = (work.authorships ?? [])
    .map((entry) => cleanText(entry?.author?.display_name))
    .filter(Boolean)
  const locations = Array.isArray(work.locations) ? work.locations : []
  const arxiv =
    locations.map((entry) => arxivFromUrl(entry?.landing_page_url) || arxivFromUrl(entry?.pdf_url)).find(Boolean) ||
    arxivFromUrl(work.primary_location?.landing_page_url) ||
    arxivFromUrl(work.primary_location?.pdf_url)
  const pdfUrl =
    work.best_oa_location?.pdf_url ||
    locations.find((entry) => entry?.is_oa && entry?.pdf_url)?.pdf_url ||
    (work.primary_location?.is_oa ? work.primary_location?.pdf_url : '') ||
    ''
  const landingUrl =
    work.primary_location?.landing_page_url ||
    work.best_oa_location?.landing_page_url ||
    (doi ? 'https://doi.org/' + doi : '')
  return {
    source: 'openalex',
    title: cleanText(work.title || work.display_name),
    authors,
    doi,
    arxiv: arxiv || '',
    abstract: rebuildAbstract(work.abstract_inverted_index),
    year: Number(work.publication_year) || 0,
    venue: cleanText(work.primary_location?.source?.display_name || work.host_venue?.display_name),
    isOa: Boolean(work.open_access?.is_oa),
    oaStatus: work.open_access?.oa_status || '',
    license: work.best_oa_location?.license || work.primary_location?.license || '',
    version: work.best_oa_location?.version || work.primary_location?.version || '',
    citedBy: Number(work.cited_by_count) || 0,
    landingUrl,
    pdfUrl,
    officialUrl: doi ? 'https://doi.org/' + doi : landingUrl,
  }
}

/** Crossref 只作为 DOI 元数据的兜底；字段比 OpenAlex 少。 */
export function normalizeCrossref(work) {
  if (!work || typeof work !== 'object') return null
  const doi = bareDoi(work.DOI)
  return {
    source: 'crossref',
    title: cleanText(work.title?.[0] || work['container-title']?.[0] || ''),
    authors: (work.author ?? []).map((author) => cleanText([author.given, author.family].filter(Boolean).join(' '))),
    doi,
    arxiv: '',
    abstract: cleanText(work.abstract),
    year: Number(work.published?.['date-parts']?.[0]?.[0] || work.issued?.['date-parts']?.[0]?.[0]) || 0,
    venue: cleanText(work['container-title']?.[0] || ''),
    isOa: false,
    oaStatus: '',
    license: (work.license ?? []).map((entry) => entry?.URL).filter(Boolean).join(' '),
    version: '',
    citedBy: Number(work['is-referenced-by-count']) || 0,
    landingUrl: doi ? 'https://doi.org/' + doi : '',
    pdfUrl: '',
    officialUrl: doi ? 'https://doi.org/' + doi : '',
    type: cleanText(work.type),
  }
}

/** DataCite JSON:API → 统一 metadata，覆盖 arXiv DOI、Zenodo 等预印本/数据源。 */
export function normalizeDatacite(payload) {
  const record = payload?.data
  const attrs = record?.attributes
  if (!record || !attrs) return null
  const doi = bareDoi(attrs.doi || record.id)
  const arxivIdentifier = (attrs.identifiers || []).find((entry) =>
    /arxiv/i.test(String(entry?.identifierType || '')),
  )?.identifier
  const alternateArxiv = (attrs.alternateIdentifiers || []).find((entry) =>
    /arxiv/i.test(String(entry?.alternateIdentifierType || '')),
  )?.alternateIdentifier
  const arxiv = normalizeArxiv(
    arxivIdentifier || alternateArxiv || (doi.match(/(?:^|\/)arxiv\.(.+)$/i)?.[1] || ''),
  )
  const descriptions = Array.isArray(attrs.descriptions) ? attrs.descriptions : []
  const abstract =
    descriptions.find((entry) => /abstract/i.test(String(entry?.descriptionType || '')))?.description ||
    descriptions[0]?.description ||
    ''
  const landingUrl =
    attrs.url ||
    (arxiv ? 'https://arxiv.org/abs/' + arxiv : doi ? 'https://doi.org/' + doi : '')
  return {
    source: 'datacite',
    title: cleanText(attrs.titles?.[0]?.title),
    authors: (attrs.creators || []).map((entry) => cleanText(entry?.name)).filter(Boolean),
    doi,
    arxiv: arxiv || '',
    abstract: cleanText(abstract),
    year: Number(attrs.publicationYear) || 0,
    venue: cleanText(attrs.publisher || attrs.container?.title),
    isOa: true,
    oaStatus: 'green',
    license: (attrs.rightsList || []).map((entry) => entry?.rightsUri).filter(Boolean).join(' '),
    version: arxiv ? 'preprint' : '',
    citedBy: 0,
    landingUrl,
    pdfUrl: arxiv ? 'https://arxiv.org/pdf/' + arxiv : '',
    officialUrl: doi ? 'https://doi.org/' + doi : landingUrl,
    type: attrs.types?.resourceTypeGeneral || '',
  }
}

/** 解析 arXiv Atom feed 的全部 entry。 */
export function parseArxivEntries(xml) {
  const text = String(xml ?? '')
  return [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map((match) => {
      const entry = match[1]
      const read = (tag) => {
        const found = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
        return found ? cleanText(found[1]) : ''
      }
      const id = read('id').match(/abs\/([^<]+)$/)?.[1] || ''
      const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)]
        .map((author) => cleanText(author[1]))
        .filter(Boolean)
      const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((link) => link[0])
      const attr = (tag, name) =>
        tag.match(new RegExp(name + '=["\']([^"\']*)["\']', 'i'))?.[1] || ''
      const pdfLink = links.find(
        (tag) => attr(tag, 'title') === 'pdf' || attr(tag, 'type') === 'application/pdf',
      )
      const alternateLink = links.find((tag) => attr(tag, 'rel') === 'alternate')
      const pdfUrl = attr(pdfLink || '', 'href')
      const alternate = attr(alternateLink || '', 'href')
      return {
        source: 'arxiv',
        title: read('title'),
        authors,
        doi: '',
        arxiv: id,
        abstract: read('summary'),
        year: Number((read('published') || read('updated')).slice(0, 4)) || 0,
        venue: 'arXiv',
        isOa: true,
        oaStatus: 'green',
        license: 'arXiv 非独占许可',
        version: 'preprint',
        citedBy: 0,
        landingUrl: alternate || (id ? 'https://arxiv.org/abs/' + id : ''),
        pdfUrl: pdfUrl || (id ? 'https://arxiv.org/pdf/' + id : ''),
        officialUrl: id ? 'https://arxiv.org/abs/' + id : '',
      }
    })
    .filter((entry) => entry.title)
}

/** 解析 arXiv Atom feed，取第一条 entry。 */
export function parseArxivFeed(xml) {
  return parseArxivEntries(xml)[0] || null
}

/** 从 OA landing page 的 citation_pdf_url / alternate link 找 PDF。 */
export function citationPdfFromHtml(html, baseUrl) {
  const text = String(html ?? '')
  const meta = text.match(
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
  )?.[1]
  const link = text.match(
    /<link[^>]+rel=["']alternate["'][^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/i,
  )?.[1]
  const raw = meta || link || ''
  if (!raw) return ''
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return ''
  }
}

/** 给 UI/日志用的版本标签；不把不确定的版本硬说成正式版。 */
export function versionFor(metadata) {
  if (metadata.arxiv) {
    return {
      kind: 'preprint',
      label: 'arXiv ' + metadata.arxiv + ' 预印本',
      source: 'arXiv',
      license: 'arXiv 非独占许可',
    }
  }
  if (metadata.version === 'publishedVersion') {
    return { kind: 'vor', label: 'OA 正式版（OpenAlex 标记）', source: 'openalex', license: metadata.license }
  }
  return { kind: 'unknown', label: '版本未核验', source: metadata.source || '', license: metadata.license }
}

async function fetchText(
  url,
  fetchImpl,
  accept = 'application/json, application/atom+xml, text/html;q=0.9',
  timeoutMs = FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      throw Object.assign(new Error('HTTP ' + response.status), {
        status: response.status,
        retryAfter: Number(response.headers?.get?.('retry-after')) || 0,
      })
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, fetchImpl) {
  return JSON.parse(await fetchText(url, fetchImpl))
}

function cacheFor(options) {
  return options?.cache === false
    ? null
    : options?.cache instanceof Map
      ? options.cache
      : DEFAULT_SEARCH_CACHE
}

function routeState(health, route, now = Date.now()) {
  const state = health?.get(route) || { failures: 0, until: 0, reason: '' }
  return {
    available: state.until <= now,
    state,
  }
}

function recordRouteSuccess(health, route) {
  health?.delete(route)
}

function recordRouteFailure(health, route, error, now = Date.now()) {
  if (!health) return
  const previous = health.get(route) || { failures: 0, until: 0, reason: '' }
  const failures = previous.failures + 1
  const status = Number(error?.status) || 0
  const retryAfterMs = Math.max(0, Number(error?.retryAfter) || 0) * 1000
  const cooldown =
    status === 429
      ? Math.max(RATE_LIMIT_COOLDOWN_MS, retryAfterMs)
      : failures >= 2
        ? ROUTE_FAILURE_COOLDOWN_MS
        : 0
  health.set(route, {
    failures,
    until: cooldown > 0 ? now + cooldown : 0,
    reason: String(error?.message || error || '检索失败').slice(0, 180),
  })
}

export function resetLookupRouteHealth(health = DEFAULT_ROUTE_HEALTH) {
  health.clear()
}

async function cachedText(url, accept, timeoutMs, fetchImpl, cache) {
  const now = Date.now()
  const cached = cache?.get(url)
  if (cached && cached.expiresAt > now) return cached.text
  const text = await fetchText(url, fetchImpl, accept, timeoutMs)
  if (cache) {
    if (cache.size >= SEARCH_CACHE_LIMIT) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) cache.delete(oldest[0])
    }
    cache.set(url, { text, expiresAt: now + SEARCH_CACHE_TTL_MS })
  }
  return text
}

async function arxivMetadata(arxivId, fetchImpl) {
  const xml = await fetchText(ARXIV_API + encodeURIComponent(arxivId), fetchImpl, 'application/atom+xml')
  return parseArxivFeed(xml)
}

async function openAlexDoi(doi, fetchImpl) {
  try {
    return normalizeOpenAlex(await fetchJson(OPENALEX_API + '/works/doi:' + encodeURIComponent(doi), fetchImpl))
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

async function crossrefDoi(doi, fetchImpl) {
  try {
    const payload = await fetchJson(CROSSREF_API + encodeURIComponent(doi), fetchImpl)
    return normalizeCrossref(payload?.message)
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

async function dataciteDoi(doi, fetchImpl) {
  try {
    return normalizeDatacite(
      await fetchJson(
        DATACITE_API + '/dois/' + encodeURIComponent(doi),
        fetchImpl,
      ),
    )
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

async function openAlexSearch(query, fetchImpl, cache) {
  const url =
    OPENALEX_API + '/works?search=' + encodeURIComponent(query) + '&per-page=8'
  const payload = JSON.parse(
    await cachedText(
      url,
      'application/json',
      SEARCH_TIMEOUT_MS,
      fetchImpl,
      cache,
    ),
  )
  return (payload?.results ?? []).map(normalizeOpenAlex).filter((entry) => entry?.title)
}

async function crossrefSearch(query, fetchImpl, cache, queryField = 'bibliographic') {
  const params = new URLSearchParams({
    rows: '8',
    select:
      'DOI,title,author,published,issued,container-title,abstract,is-referenced-by-count,license,type',
  })
  params.set(queryField === 'title' ? 'query.title' : 'query.bibliographic', query)
  const payload = JSON.parse(
    await cachedText(
      CROSSREF_SEARCH_API + params.toString(),
      'application/json',
      SEARCH_TIMEOUT_MS,
      fetchImpl,
      cache,
    ),
  )
  return (payload?.message?.items ?? []).map(normalizeCrossref).filter((entry) => entry?.title)
}

async function arxivSearch(query, fetchImpl, cache) {
  const params = new URLSearchParams({
    search_query: 'all:"' + query + '"',
    start: '0',
    max_results: '8',
  })
  const xml = await cachedText(
    ARXIV_SEARCH_API + params.toString(),
    'application/atom+xml',
    SEARCH_TIMEOUT_MS,
    fetchImpl,
    cache,
  )
  return parseArxivEntries(xml)
}

async function dataciteSearch(query, fetchImpl, cache) {
  const params = new URLSearchParams({
    query,
    'page[size]': '8',
  })
  const payload = JSON.parse(
    await cachedText(
      DATACITE_API + '/dois?' + params.toString(),
      'application/vnd.api+json, application/json',
      SEARCH_TIMEOUT_MS,
      fetchImpl,
      cache,
    ),
  )
  return (payload?.data || []).map((record) => normalizeDatacite({ data: record })).filter((entry) => entry?.title)
}

async function arxivOrDatacite(arxivId, fetchImpl) {
  try {
    const metadata = await arxivMetadata(arxivId, fetchImpl)
    if (metadata) return { metadata, route: 'arxiv' }
  } catch {
    // arXiv API 不可达时继续走 DataCite；不让精确编号查询直接失败。
  }
  const metadata = await dataciteDoi('10.48550/arxiv.' + arxivId, fetchImpl)
  return metadata ? { metadata, route: 'arxiv-datacite' } : { metadata: null, route: '' }
}

function normalizeTitle(value) {
  return queryKey(value)
    .replace(/\b(?:a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value) {
  return queryKey(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

function jaccard(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function containment(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / Math.min(a.size, b.size)
}

function charBigrams(value) {
  const text = normalizeTitle(value).replace(/\s+/g, ' ')
  if (text.length < 2) return [text]
  const result = []
  for (let index = 0; index < text.length - 1; index += 1) result.push(text.slice(index, index + 2))
  return result
}

function dice(left, right) {
  const a = charBigrams(left)
  const b = charBigrams(right)
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map()
  for (const gram of a) counts.set(gram, (counts.get(gram) || 0) + 1)
  let intersection = 0
  for (const gram of b) {
    const count = counts.get(gram) || 0
    if (count > 0) {
      intersection += 1
      counts.set(gram, count - 1)
    }
  }
  return (2 * intersection) / (a.length + b.length)
}

function titleSimilarity(left, right) {
  const a = tokens(left)
  const b = tokens(right)
  if (a.length === 0 || b.length === 0) return 0
  if (normalizeTitle(left) === normalizeTitle(right)) return 1
  const tokenScore = 0.75 * jaccard(a, b) + 0.25 * dice(left, right)
  const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const partialContainment =
    containment(a, b) * (lengthRatio >= 0.8 ? 0.84 : 0.65 * lengthRatio)
  return Math.max(tokenScore, partialContainment)
}

function authorSurname(value) {
  const text = cleanText(value)
  if (!text) return ''
  if (/[\u4e00-\u9fff]/.test(text)) return queryKey(text)
  const words = queryKey(text).split(' ').filter(Boolean)
  return words.at(-1) || ''
}

function authorOverlap(target, candidateAuthors) {
  const wanted = new Set(
    String(target ?? '')
      .split(/[;,]/)
      .map(authorSurname)
      .filter(Boolean),
  )
  if (wanted.size === 0) return 0
  const found = new Set((candidateAuthors || []).map(authorSurname).filter(Boolean))
  let matches = 0
  for (const name of wanted) if (found.has(name)) matches += 1
  return matches / wanted.size
}

function contextOverlap(target, candidate) {
  const haystack = [candidate?.title, candidate?.abstract, candidate?.venue]
    .filter(Boolean)
    .join(' ')
  const targetTokens = tokens(target)
  const candidateTokens = tokens(haystack)
  if (targetTokens.length < 6 || candidateTokens.length === 0) return 0
  return Math.max(jaccard(targetTokens, candidateTokens), containment(targetTokens, candidateTokens) * 0.8)
}

function candidateKey(candidate) {
  if (candidate?.doi) return 'doi:' + bareDoi(candidate.doi)
  if (candidate?.arxiv) return 'arxiv:' + String(candidate.arxiv).toLowerCase()
  return 'title:' + normalizeTitle(candidate?.title)
}

function preferLongerText(left, right) {
  return String(right || '').length > String(left || '').length ? right : left
}

function mergeCandidate(existing, incoming, route, queryKind) {
  const provenance = [...(existing?._provenance || []), { route, queryKind }]
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== '' && value !== null && value !== undefined),
    ),
    title: preferLongerText(existing?.title, incoming.title),
    authors:
      (incoming.authors?.length || 0) > (existing?.authors?.length || 0)
        ? incoming.authors
        : existing?.authors || incoming.authors || [],
    abstract: preferLongerText(existing?.abstract, incoming.abstract),
    doi: existing?.doi || incoming.doi || '',
    arxiv: existing?.arxiv || incoming.arxiv || '',
    isOa: Boolean(existing?.isOa || incoming.isOa),
    citedBy: Math.max(Number(existing?.citedBy) || 0, Number(incoming.citedBy) || 0),
    _provenance: provenance,
  }
}

/** 按 DOI > arXiv > 规范化标题合并多路检索结果。 */
export function mergeLookupCandidates(records = []) {
  const byKey = new Map()
  let duplicates = 0
  for (const record of records) {
    const candidate = record?.candidate || record
    if (!candidate?.title && !candidate?.doi && !candidate?.arxiv) continue
    const key = candidateKey(candidate)
    const current = byKey.get(key)
    if (current) duplicates += 1
    byKey.set(
      key,
      current
        ? mergeCandidate(current, candidate, record.route, record.queryKind)
        : mergeCandidate(candidate, candidate, record.route, record.queryKind),
    )
  }
  return { candidates: [...byKey.values()], duplicateCount: duplicates }
}

function reasonLabel(kind, detail) {
  const labels = {
    identifier: '标识符',
    title: '标题',
    author: '作者',
    year: '年份',
    venue: '刊物/会议',
    context: '引用上下文',
    reference: '参考文献表',
    route: '多路命中',
  }
  return detail ? `${labels[kind]}：${detail}` : labels[kind]
}

/**
 * 可解释匹配分。分数不是概率，只用于同一批候选内排序。
 */
export function rankLookupCandidates(candidates = [], fields = {}) {
  const targetTitle = cleanText(fields.title || fields.query)
  const targetAuthors = cleanText(fields.authors)
  const targetVenue = cleanText(fields.venue)
  const targetYear = Number(fields.year) || 0
  const targetDoi = bareDoi(fields.doi)
  const targetArxiv = normalizeArxiv(fields.arxiv) || ''
  const targetContext = cleanText(
    [fields.citationContext, fields.referenceText, fields.query, fields.title]
      .filter(Boolean)
      .join(' '),
  )
  const ranked = candidates.map((candidate) => {
    const reasons = []
    const titleScore = titleSimilarity(targetTitle, candidate.title)
    const authorsScore = targetAuthors ? authorOverlap(targetAuthors, candidate.authors) : 0
    const candidateYear = Number(candidate.year) || 0
    const yearScore =
      targetYear && candidateYear
        ? candidateYear === targetYear
          ? 1
          : Math.abs(candidateYear - targetYear) === 1
            ? 0.45
            : 0
        : 0
    const venueScore =
      targetVenue && candidate.venue ? titleSimilarity(targetVenue, candidate.venue) : 0
    const identifierMatch =
      (targetDoi && bareDoi(candidate.doi) === targetDoi) ||
      (targetArxiv && normalizeArxiv(candidate.arxiv) === targetArxiv)
    const contextScore = contextOverlap(targetContext, candidate)
    const provenance = Array.isArray(candidate._provenance) ? candidate._provenance : []
    const routeCount = new Set(provenance.map((entry) => entry.route).filter(Boolean)).size
    const rawScore =
      50 * titleScore +
      18 * authorsScore +
      10 * yearScore +
      8 * venueScore +
      (identifierMatch ? 20 : 0) +
      12 * contextScore +
      (fields.fromReference ? 2 : 0) +
      Math.min(4, Math.max(0, routeCount - 1) * 2)
    const matchScore = Math.max(0, Math.min(100, Math.round(rawScore)))
    if (identifierMatch) reasons.push(reasonLabel('identifier', targetDoi ? 'DOI 一致' : 'arXiv 编号一致'))
    if (titleScore >= 0.72) reasons.push(reasonLabel('title', `相似 ${Math.round(titleScore * 100)}%`))
    else if (titleScore >= 0.38) reasons.push(reasonLabel('title', `部分相似 ${Math.round(titleScore * 100)}%`))
    if (authorsScore >= 0.5) reasons.push(reasonLabel('author', `命中 ${Math.round(authorsScore * 100)}%`))
    if (yearScore === 1) reasons.push(reasonLabel('year', String(targetYear)))
    else if (yearScore > 0) reasons.push(reasonLabel('year', `相差 1 年（${candidateYear}）`))
    if (venueScore >= 0.55) reasons.push(reasonLabel('venue', candidate.venue))
    if (contextScore >= 0.18) {
      reasons.push(reasonLabel('context', `词项重叠 ${Math.round(contextScore * 100)}%`))
    }
    if (fields.fromReference) reasons.push(reasonLabel('reference', '来自当前论文的参考文献条目'))
    if (routeCount > 1) reasons.push(reasonLabel('route', `${routeCount} 路同时命中`))
    const confidence =
      identifierMatch || matchScore >= 75
        ? 'high'
        : matchScore >= 55
          ? 'medium'
          : 'low'
    return {
      ...candidate,
      _provenance: provenance,
      retrievalRoutes: [...new Set(provenance.map((entry) => entry.route).filter(Boolean))],
      matchScore,
      confidence,
      confidenceLabel: confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低',
      reasons: reasons.slice(0, 6),
      matchDetails: {
        title: Number(titleScore.toFixed(3)),
        authors: Number(authorsScore.toFixed(3)),
        year: Number(yearScore.toFixed(3)),
        venue: Number(venueScore.toFixed(3)),
        context: Number(contextScore.toFixed(3)),
        identifier: Boolean(identifierMatch),
      },
    }
  })
  ranked.sort(
    (left, right) =>
      right.matchScore - left.matchScore ||
      Number(Boolean(right.retrievalRoutes?.length > 1)) -
        Number(Boolean(left.retrievalRoutes?.length > 1)) ||
      left.title.localeCompare(right.title),
  )
  const close =
    ranked.length > 1 &&
    ranked[0].matchScore >= 50 &&
    ranked[0].matchScore - ranked[1].matchScore <= 5
  return ranked.map((candidate, index) => ({
    ...candidate,
    isPrimary: index === 0,
    isAmbiguous: close && index < 2,
    ambiguityReason: close ? '前两项匹配分接近，需要核对题名与来源' : '',
  }))
}

/**
 * 解析一次查询，返回精确结果 / 候选列表 / metadata-only。
 * 不下载全文；全文由后续 fetch 接口启动后台任务。
 * @param {object} fields - query/title/authors/venue/year/doi/arxiv/strictPublished。
 * @param {object} options - fetchImpl 与 existing 回调。
 * @returns {Promise<object>} 查询结果。
 */
export async function resolveLookup(
  fields = {},
  {
    fetchImpl = fetch,
    existing,
    cache = DEFAULT_SEARCH_CACHE,
    maxQueries = 3,
    searchQueries = null,
    routeHealth = DEFAULT_ROUTE_HEALTH,
  } = {},
) {
  const query = String(fields.query ?? '').trim()
  const explicitDoi = normalizeDoi(fields.doi)
  const explicitArxiv = normalizeArxiv(fields.arxiv)
  const parsedDoi = normalizeDoi(query)
  const parsedArxiv = normalizeArxiv(query)
  const doi = explicitDoi || parsedDoi
  const arxiv = explicitArxiv || parsedArxiv || (doi ? arxivFromDoi(doi) : undefined)
  const strictPublished = Boolean(fields.strictPublished)
  const canFallbackToSearch = Boolean(
    cleanText(fields.title) ||
      cleanText(fields.authors) ||
      cleanText(fields.venue) ||
      cleanText(fields.year) ||
      (cleanText(fields.query) &&
        cleanText(fields.query) !== cleanText(fields.doi) &&
        cleanText(fields.query) !== cleanText(fields.arxiv)),
  )

  if (arxiv) {
    let metadata = null
    try {
      metadata = (await arxivOrDatacite(arxiv, fetchImpl)).metadata
    } catch {
      metadata = null
    }
    if (!metadata && !canFallbackToSearch) {
      return {
        kind: 'none',
        reason: 'retrieval-unavailable',
        retryable: true,
        message: 'arXiv 与 DataCite 暂时不可达；这不是编号不存在。',
      }
    }
    if (metadata) {
      if (strictPublished) {
        const existingJobId = await existing?.(metadata)
        return {
          kind: 'metadata-only',
          reason: 'strict-published',
          message: '陛下要正式版：这是 arXiv 预印本，先去官方页面核对/下载。',
          metadata,
          existingJobId,
          officialUrl: metadata.officialUrl,
          version: versionFor(metadata),
        }
      }
      const existingJobId = await existing?.(metadata)
      if (existingJobId) return { kind: 'existing', existingJobId, metadata, version: versionFor(metadata) }
      return {
        kind: 'exact',
        route: 'arxiv-html',
        fallbackRoute: 'arxiv-pdf',
        metadata,
        sourceUrl: 'https://arxiv.org/html/' + arxiv,
        version: versionFor(metadata),
      }
    }
  }

  if (doi) {
    let metadata = null
    if (arxivFromDoi(doi)) {
      metadata = (await arxivOrDatacite(arxivFromDoi(doi), fetchImpl).catch(() => ({ metadata: null }))).metadata
    }
    if (!metadata) {
      try {
        metadata = await openAlexDoi(doi, fetchImpl)
      } catch {
        metadata = null
      }
    }
    if (!metadata) {
      metadata = await crossrefDoi(doi, fetchImpl).catch(() => null)
    }
    if (!metadata) {
      metadata = await dataciteDoi(doi, fetchImpl).catch(() => null)
    }
    if (!metadata && !canFallbackToSearch) {
      return {
        kind: 'none',
        reason: 'retrieval-unavailable',
        retryable: true,
        message: 'DOI 元数据服务暂时不可达；这不是 DOI 不存在。',
      }
    }
    if (metadata) {
      if (strictPublished) {
        const existingJobId = await existing?.(metadata)
        return {
          kind: 'metadata-only',
          reason: 'strict-published',
          message: '陛下要正式版：小的我只给官方链接，陛下自行下载后再用 PDF 入口抄写。',
          metadata,
          existingJobId,
          officialUrl: metadata.officialUrl || metadata.landingUrl,
          version: versionFor(metadata),
        }
      }
      const existingJobId = await existing?.(metadata)
      if (existingJobId) return { kind: 'existing', existingJobId, metadata, version: versionFor(metadata) }
      if (metadata.arxiv) {
        return {
          kind: 'exact',
          route: 'arxiv-html',
          fallbackRoute: 'arxiv-pdf',
          metadata,
          sourceUrl: 'https://arxiv.org/html/' + metadata.arxiv,
          version: versionFor(metadata),
        }
      }
      let pdfUrl = metadata.pdfUrl
      if (!pdfUrl && metadata.landingUrl) {
        try {
          const html = await fetchText(metadata.landingUrl, fetchImpl, 'text/html,application/xhtml+xml')
          pdfUrl = citationPdfFromHtml(html, metadata.landingUrl)
        } catch {
          // 出版社 403 / 反爬时不再硬闯，走 metadata-only。
        }
      }
      if (pdfUrl) {
        return {
          kind: 'exact',
          route: 'oa-pdf',
          metadata,
          sourceUrl: pdfUrl,
          version: versionFor(metadata),
        }
      }
      return {
        kind: 'metadata-only',
        reason: 'no-oa-fulltext',
        message: '只找到元数据，没有找到可合法取回的 OA 全文。',
        metadata,
        officialUrl: metadata.officialUrl || metadata.landingUrl,
        version: versionFor(metadata),
      }
    }
  }

  const queries =
    Array.isArray(searchQueries) && searchQueries.length > 0
      ? uniqueBy(
          searchQueries
            .map((entry) => ({
              kind: cleanText(entry?.kind) || 'custom',
              text: cleanText(entry?.text),
            }))
            .filter((entry) => entry.text),
          (entry) => queryKey(entry.text),
        )
      : buildLookupQueries(fields)
  const searchText = buildSearchText(fields)
  if (queries.length === 0) {
    return { kind: 'none', reason: 'empty-query', message: '至少给一个标题、作者、刊物、年份或编号。' }
  }
  const selectedQueries = queries.slice(0, Math.max(1, Math.min(5, Number(maxQueries) || 3)))
  const routePlans = []
  const diagnostics = []
  const addRoute = (route, queryKind, run) => {
    const status = routeState(routeHealth, route)
    if (!status.available) {
      diagnostics.push({
        route,
        queryKind,
        status: 'skipped',
        count: 0,
        error: '冷却中：' + (status.state.reason || '近期请求失败'),
        retryAt: new Date(status.state.until).toISOString(),
      })
      return
    }
    routePlans.push({ route, queryKind, run })
  }
  const firstQuery = selectedQueries[0]
  if (firstQuery) {
    addRoute('openalex', firstQuery.kind, () =>
      openAlexSearch(firstQuery.text, fetchImpl, cacheFor({ cache })),
    )
  }
  for (const query of selectedQueries.slice(0, 2)) {
    addRoute('crossref', query.kind, () =>
      crossrefSearch(query.text, fetchImpl, cacheFor({ cache })),
    )
  }
  const titleQuery = selectedQueries.find(
    (query) => query.kind === 'title' || query.kind === 'title_without_subtitle',
  )
  if (titleQuery) {
    addRoute('crossref-title', titleQuery.kind, () =>
      crossrefSearch(titleQuery.text, fetchImpl, cacheFor({ cache }), 'title'),
    )
    addRoute('datacite', titleQuery.kind, () =>
      dataciteSearch(titleQuery.text, fetchImpl, cacheFor({ cache })),
    )
  }
  if (titleQuery) {
    addRoute('arxiv', titleQuery.kind, () =>
      arxivSearch(titleQuery.text, fetchImpl, cacheFor({ cache })),
    )
  }

  const settled = await Promise.allSettled(routePlans.map((plan) => plan.run()))
  const records = []
  settled.forEach((result, index) => {
    const plan = routePlans[index]
    if (result.status === 'fulfilled') {
      recordRouteSuccess(routeHealth, plan.route)
      const entries = Array.isArray(result.value) ? result.value : []
      for (const candidate of entries) {
        records.push({ candidate, route: plan.route, queryKind: plan.queryKind })
      }
      diagnostics.push({
        route: plan.route,
        queryKind: plan.queryKind,
        status: 'ok',
        count: entries.length,
      })
    } else {
      recordRouteFailure(routeHealth, plan.route, result.reason)
      diagnostics.push({
        route: plan.route,
        queryKind: plan.queryKind,
        status: 'failed',
        count: 0,
        error: String(result.reason?.message || result.reason || '检索失败').slice(0, 240),
      })
    }
  })
  const merged = mergeLookupCandidates(records)
  const ranked = rankLookupCandidates(merged.candidates, {
    ...fields,
    query: fields.query || searchText,
    fromReference: Boolean(fields.fromReference),
  })
  for (const candidate of ranked) {
    candidate.existingJobId = (await existing?.(candidate)) || ''
  }
  const routeOk = diagnostics.some((entry) => entry.status === 'ok')
  const retrieval = {
    queryVariants: selectedQueries,
    routes: diagnostics,
    duplicateCount: merged.duplicateCount,
    uniqueCount: ranked.length,
    returnedCount: Math.min(12, ranked.length),
    metricsScope: 'current-query-only',
  }
  if (ranked.length === 0) {
    return {
      kind: 'none',
      reason: routeOk ? 'no-match' : 'retrieval-unavailable',
      retryable: !routeOk,
      message: routeOk
        ? '没有匹配到论文，换个关键词试试。'
        : '检索服务暂时不可用；这是服务降级，不是陛下填错了信息。',
      searchText,
      retrieval,
    }
  }
  return {
    kind: 'candidates',
    candidates: ranked.slice(0, 12),
    searchText,
    retrieval,
    ambiguous: ranked[0]?.isAmbiguous || false,
  }
}
