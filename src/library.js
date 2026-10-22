// 文档管理的数据模型：持久状态、完整性、版本分组与批量展示。
// 这里只放无 I/O 的纯逻辑，服务端文件读写留在 papers.js。

export const LIBRARY_ENTRY_FILE = 'library-entry.json'
export const LIBRARY_STATUSES = Object.freeze([
  'imported',
  'queued',
  'converting',
  'ready',
  'failed',
  'missing',
])

const STATUS_SET = new Set(LIBRARY_STATUSES)

/** 规范化标题只用于识别副本，不改变展示文本。 */
export function normalizedLibraryTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 在 DOI、arXiv、标题和文件哈希之间选出稳定的版本组键。 */
export function libraryGroupKey(item) {
  const doi = String(item?.doi || '').toLowerCase()
  if (doi) return 'doi:' + doi
  const arxiv = String(item?.arxiv || '').toLowerCase()
  if (arxiv) return 'arxiv:' + arxiv
  const title = normalizedLibraryTitle(item?.title)
  if (title) return 'title:' + title
  const sha256 = String(item?.sha256 || '').toLowerCase()
  if (sha256) return 'sha256:' + sha256
  return 'job:' + String(item?.jobId || '')
}

/** 把旧状态或损坏值收敛到 B8 六态，未知值不伪装成 ready。 */
export function normalizeLibraryStatus(value, fallback = 'imported') {
  const status = String(value || '').toLowerCase()
  if (status === 'done') return 'ready'
  if (status === 'running') return 'converting'
  if (STATUS_SET.has(status)) return status
  return STATUS_SET.has(fallback) ? fallback : 'failed'
}

export function normalizeLibraryMetadata(input) {
  return {
    title: String(input?.title || '').trim(),
    authors: Array.isArray(input?.authors)
      ? input.authors.map(String).filter(Boolean).join(', ')
      : String(input?.authors || '').trim(),
    doi: String(input?.doi || '').trim(),
    arxiv: String(input?.arxiv || input?.arxivId || '').trim(),
    venue: String(input?.venue || '').trim(),
    year: String(input?.year || '').trim(),
  }
}

export function createLibraryEntry({
  jobId,
  originalName = '',
  sha256 = '',
  bytes = 0,
  pipeline = 'pdf',
  source = 'local-pdf',
  status = 'imported',
  stage = 'imported',
  message = '',
  error = null,
  metadata = {},
  importedAt = new Date().toISOString(),
  updatedAt = importedAt,
  trashedAt = '',
  artifacts = {},
}) {
  return {
    version: 1,
    jobId: String(jobId || ''),
    originalName: String(originalName || ''),
    sha256: String(sha256 || '').toLowerCase(),
    bytes: Math.max(0, Number(bytes) || 0),
    pipeline: pipeline === 'html' ? 'html' : 'pdf',
    source: String(source || 'local-pdf'),
    status: normalizeLibraryStatus(status),
    stage: String(stage || status || 'imported'),
    message: String(message || ''),
    error: error ? String(error) : null,
    metadata: normalizeLibraryMetadata(metadata),
    importedAt: String(importedAt || ''),
    updatedAt: String(updatedAt || importedAt || ''),
    readyAt: status === 'ready' ? String(updatedAt || importedAt || '') : '',
    trashedAt: String(trashedAt || ''),
    artifacts: {
      originalPdf: Boolean(artifacts.originalPdf),
      mirrorDoc: Boolean(artifacts.mirrorDoc),
      paperSummary: Boolean(artifacts.paperSummary),
      sourcePages: Boolean(artifacts.sourcePages),
      assets: Boolean(artifacts.assets),
    },
  }
}

/** 兼容手写/旧版 manifest；字段缺失时用现有文件事实补足。 */
export function normalizeLibraryEntry(raw, fallback = {}) {
  const merged = { ...fallback, ...(raw && typeof raw === 'object' ? raw : {}) }
  return createLibraryEntry({
    ...merged,
    status: normalizeLibraryStatus(merged.status, fallback.status || 'imported'),
    importedAt: merged.importedAt || fallback.importedAt || new Date().toISOString(),
    updatedAt: merged.updatedAt || fallback.updatedAt || merged.importedAt,
  })
}

/**
 * 返回未折叠的版本组。组内主条目优先 ready，其次批注多、更新时间新；
 * 管理页可展开全部物理文档，旧主页仍可只取 primary。
 */
export function groupLibraryItems(items) {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const key = libraryGroupKey(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const output = []
  for (const [key, groupItems] of groups) {
    const sorted = [...groupItems].sort((left, right) => {
      if (left.status === 'ready' && right.status !== 'ready') return -1
      if (right.status === 'ready' && left.status !== 'ready') return 1
      const annotations = Number(right.annotationCount || 0) - Number(left.annotationCount || 0)
      if (annotations) return annotations
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    })
    output.push({
      key,
      primaryJobId: sorted[0]?.jobId || '',
      count: sorted.length,
      status: sorted.length > 1 ? 'versions' : sorted[0]?.status || 'imported',
      items: sorted,
    })
  }
  output.sort((left, right) =>
    String(right.items[0]?.updatedAt || '').localeCompare(String(left.items[0]?.updatedAt || '')),
  )
  return output
}
