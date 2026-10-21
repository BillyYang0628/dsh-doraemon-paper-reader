// 论文查询与来源选择（B 的纯逻辑层）。
//
// 这里不碰文件、不启动 Python；只做：
//   - DOI / arXiv / 标题+作者+刊物+年份 → 规范化查询
//   - OpenAlex / arXiv / Crossref → 统一 metadata
//   - 合法来源阶梯：arXiv HTML → arXiv PDF → OA PDF → metadata-only
//   - 严格正式版时只给官方链接，不擅自取预印本正文

import { normalizeArxiv, normalizeDoi } from './identifiers.js'

const ARXIV_API = 'https://export.arxiv.org/api/query?id_list='
const OPENALEX_API = 'https://api.openalex.org'
const CROSSREF_API = 'https://api.crossref.org/works/'
const USER_AGENT = 'dsh-doraemon-paper-reader/0.1.0 (local research tool)'
const FETCH_TIMEOUT_MS = 45000

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
  }
}

/** 解析 arXiv Atom feed，取第一条 entry。 */
export function parseArxivFeed(xml) {
  const text = String(xml ?? '')
  const entry = text.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1]
  if (!entry) return null
  const read = (tag) => {
    const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return match ? cleanText(match[1]) : ''
  }
  const id = read('id').match(/abs\/([^<]+)$/)?.[1] || ''
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
  const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0])
  const attr = (tag, name) => tag.match(new RegExp(name + '=["\']([^"\']*)["\']', 'i'))?.[1] || ''
  const pdfLink = links.find((tag) => attr(tag, 'title') === 'pdf' || attr(tag, 'type') === 'application/pdf')
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

async function fetchText(url, fetchImpl, accept = 'application/json, application/atom+xml, text/html;q=0.9') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      throw Object.assign(new Error('HTTP ' + response.status), { status: response.status })
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, fetchImpl) {
  return JSON.parse(await fetchText(url, fetchImpl))
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

async function openAlexSearch(query, fetchImpl) {
  const payload = await fetchJson(
    OPENALEX_API + '/works?search=' + encodeURIComponent(query) + '&per-page=5',
    fetchImpl,
  )
  return (payload?.results ?? []).map(normalizeOpenAlex).filter((entry) => entry?.title)
}

/**
 * 解析一次查询，返回精确结果 / 候选列表 / metadata-only。
 * 不下载全文；全文由后续 fetch 接口启动后台任务。
 * @param {object} fields - query/title/authors/venue/year/doi/arxiv/strictPublished。
 * @param {object} options - fetchImpl 与 existing 回调。
 * @returns {Promise<object>} 查询结果。
 */
export async function resolveLookup(fields = {}, { fetchImpl = fetch, existing } = {}) {
  const query = String(fields.query ?? '').trim()
  const explicitDoi = normalizeDoi(fields.doi)
  const explicitArxiv = normalizeArxiv(fields.arxiv)
  const parsedDoi = normalizeDoi(query)
  const parsedArxiv = normalizeArxiv(query)
  const doi = explicitDoi || parsedDoi
  const arxiv = explicitArxiv || parsedArxiv || (doi ? arxivFromDoi(doi) : undefined)
  const strictPublished = Boolean(fields.strictPublished)

  if (arxiv) {
    const metadata = await arxivMetadata(arxiv, fetchImpl)
    if (!metadata) return { kind: 'none', message: 'arXiv 上没有找到这个编号。' }
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
    const route = 'arxiv-html'
    return {
      kind: 'exact',
      route,
      fallbackRoute: 'arxiv-pdf',
      metadata,
      sourceUrl: 'https://arxiv.org/html/' + arxiv,
      version: versionFor(metadata),
    }
  }

  if (doi) {
    let metadata = await openAlexDoi(doi, fetchImpl)
    if (!metadata) metadata = await crossrefDoi(doi, fetchImpl)
    if (!metadata) return { kind: 'none', message: 'DOI 没有在 OpenAlex/Crossref 找到。' }
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

  const searchText = buildSearchText(fields)
  if (!searchText) return { kind: 'none', message: '至少给一个标题、作者、刊物、年份或编号。' }
  const candidates = await openAlexSearch(searchText, fetchImpl)
  if (candidates.length === 0) return { kind: 'none', message: '没有匹配到论文，换个关键词试试。' }
  for (const candidate of candidates) {
    candidate.existingJobId = (await existing?.(candidate)) || ''
  }
  return { kind: 'candidates', candidates, searchText }
}
