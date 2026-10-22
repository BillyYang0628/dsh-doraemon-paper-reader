// P3 知识层纯逻辑：统一索引条目、跨论文检索、引用图、阅读档案与导出格式。
// 文件读写与权限边界留在 papers.js；本模块不直接访问用户目录或网络。

import { createHash } from 'node:crypto'

export const KNOWLEDGE_INDEX_VERSION = 1

export const KNOWLEDGE_SOURCE_TYPES = Object.freeze([
  'text',
  'annotation',
  'translation',
  'term',
  'citation',
  'qa',
  'report',
])

const SOURCE_SET = new Set(KNOWLEDGE_SOURCE_TYPES)
const SOURCE_LABELS = Object.freeze({
  text: '论文正文',
  annotation: '批注',
  translation: '中文翻译',
  term: '术语',
  citation: '参考文献',
  qa: '问答记录',
  report: '综述报告',
})
const SOURCE_WEIGHTS = Object.freeze({
  text: 1,
  annotation: 1.35,
  translation: 0.92,
  term: 1.3,
  citation: 1.08,
  qa: 1.3,
  report: 1.22,
})

const QUERY_STOPWORDS = new Set([
  'and',
  'are',
  'for',
  'from',
  'into',
  'that',
  'the',
  'this',
  'with',
  '的',
  '了',
  '和',
  '与',
  '是',
])

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function clip(value, limit) {
  const text = clean(value)
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

function normalized(value) {
  return clean(value).toLowerCase()
}

function safeSourceType(value) {
  const type = String(value || '')
  return SOURCE_SET.has(type) ? type : 'text'
}

function entryHash(parts) {
  return createHash('sha1').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex').slice(0, 12)
}

export function createKnowledgeEntry(input) {
  const sourceType = safeSourceType(input?.sourceType)
  const jobId = String(input?.jobId || '')
  const blockId = String(input?.blockId || '')
  const text = clip(input?.text, 2200)
  if (!jobId || !text) return null
  return {
    id:
      String(input?.id || '') ||
      sourceType + ':' + jobId + ':' + (blockId || 'none') + ':' + entryHash([sourceType, blockId, text]),
    sourceType,
    sourceLabel: SOURCE_LABELS[sourceType],
    jobId,
    blockId,
    page: Math.max(0, Number(input?.page) || 0),
    section: clip(input?.section, 120),
    title: clip(input?.title, 220),
    paperTitle: clip(input?.paperTitle, 220),
    authors: clip(input?.authors, 180),
    doi: clean(input?.doi),
    arxiv: clean(input?.arxiv),
    text,
    updatedAt: String(input?.updatedAt || ''),
    metadata:
      input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? input.metadata
        : {},
  }
}

export function knowledgeSourceLabel(type) {
  return SOURCE_LABELS[safeSourceType(type)]
}

/** 同时覆盖英文词和中文二元组；用于无外部依赖的本地召回。 */
export function knowledgeQueryTerms(query) {
  const text = normalized(query)
  if (!text) return []
  const terms = new Set()
  for (const word of text.match(/[a-z0-9][a-z0-9.+#_-]*[a-z0-9]|[a-z0-9]/gi) || []) {
    if (word.length >= 2 && !QUERY_STOPWORDS.has(word)) terms.add(word)
  }
  for (const sequence of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    if (sequence.length <= 4) terms.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const bigram = sequence.slice(index, index + 2)
      if (!QUERY_STOPWORDS.has(bigram)) terms.add(bigram)
    }
  }
  return [...terms].slice(0, 24)
}

function countOccurrences(text, term) {
  if (!text || !term) return 0
  let count = 0
  let offset = 0
  while (offset < text.length) {
    const found = text.indexOf(term, offset)
    if (found < 0) break
    count += 1
    offset = found + term.length
    if (count >= 10) break
  }
  return count
}

function resultSnippet(entry, terms, query) {
  const source = clean(entry.text)
  if (!source) return ''
  const lower = source.toLowerCase()
  const phrase = normalized(query)
  let position = phrase ? lower.indexOf(phrase) : -1
  if (position < 0) {
    for (const term of terms) {
      position = lower.indexOf(term)
      if (position >= 0) break
    }
  }
  if (position < 0) return clip(source, 260)
  const start = Math.max(0, position - 90)
  const end = Math.min(source.length, position + 180)
  return (start > 0 ? '…' : '') + source.slice(start, end).trim() + (end < source.length ? '…' : '')
}

/**
 * 本地两阶段检索的第一阶段：反文档频率 + 字段权重 + 精确短语。
 * 所有结果都保留 jobId/blockId，供 UI 回原文。
 */
export function searchKnowledge(entries, options = {}) {
  const query = clean(options.query)
  const types = new Set(
    (Array.isArray(options.sourceTypes) ? options.sourceTypes : [])
      .map(String)
      .filter((type) => SOURCE_SET.has(type)),
  )
  const jobIds = new Set((Array.isArray(options.jobIds) ? options.jobIds : []).map(String).filter(Boolean))
  const since = Number(options.since) || 0
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 30))
  const candidates = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (types.size > 0 && !types.has(entry.sourceType)) return false
    if (jobIds.size > 0 && !jobIds.has(entry.jobId)) return false
    if (since > 0 && Date.parse(entry.updatedAt || '') < since) return false
    return true
  })
  const terms = knowledgeQueryTerms(query)
  if (!query) {
    return {
      query,
      terms,
      totalCandidates: candidates.length,
      results: candidates
        .slice()
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        .slice(0, limit),
    }
  }
  const prepared = candidates.map((entry) => {
    const text = normalized(entry.text)
    const title = normalized(entry.title + ' ' + entry.paperTitle + ' ' + entry.section)
    return { entry, text, title }
  })
  const documentFrequency = new Map()
  for (const term of terms) {
    documentFrequency.set(
      term,
      prepared.reduce(
        (total, item) => total + (item.text.includes(term) || item.title.includes(term) ? 1 : 0),
        0,
      ),
    )
  }
  const phrase = normalized(query)
  const total = Math.max(1, prepared.length)
  const results = []
  for (const item of prepared) {
    let score = 0
    const matchedTerms = []
    for (const term of terms) {
      const inText = countOccurrences(item.text, term)
      const inTitle = countOccurrences(item.title, term)
      if (inText === 0 && inTitle === 0) continue
      matchedTerms.push(term)
      const df = documentFrequency.get(term) || 0
      const idf = Math.log((total + 1) / (df + 1)) + 1
      score += (Math.min(3, inText) + inTitle * 4) * idf
    }
    if (item.title.includes(phrase)) score += 9
    if (item.text.includes(phrase)) score += 6
    if (matchedTerms.length === 0) continue
    score *= SOURCE_WEIGHTS[item.entry.sourceType] || 1
    results.push({
      ...item.entry,
      score: Number(score.toFixed(3)),
      matchedTerms,
      snippet: resultSnippet(item.entry, terms, query),
    })
  }
  results.sort(
    (left, right) =>
      right.score - left.score || String(right.updatedAt).localeCompare(String(left.updatedAt)),
  )
  return {
    query,
    terms,
    totalCandidates: candidates.length,
    results: results.slice(0, limit),
  }
}

export function groupKnowledgeResults(results) {
  const groups = new Map()
  for (const item of Array.isArray(results) ? results : []) {
    if (!groups.has(item.jobId)) {
      groups.set(item.jobId, {
        jobId: item.jobId,
        title: item.paperTitle || item.title || item.jobId,
        authors: item.authors || '',
        doi: item.doi || '',
        arxiv: item.arxiv || '',
        score: 0,
        items: [],
      })
    }
    const group = groups.get(item.jobId)
    group.score += Number(item.score) || 0
    group.items.push(item)
  }
  return [...groups.values()]
    .map((group) => {
      group.items.sort((left, right) => Number(right.score) - Number(left.score))
      group.score = Number(group.score.toFixed(3))
      return group
    })
    .sort((left, right) => right.score - left.score)
}

export function knowledgeFacets(entries) {
  const byType = Object.fromEntries(KNOWLEDGE_SOURCE_TYPES.map((type) => [type, 0]))
  const papers = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    byType[entry.sourceType] = (byType[entry.sourceType] || 0) + 1
    papers.add(entry.jobId)
  }
  return {
    total: Array.isArray(entries) ? entries.length : 0,
    papers: papers.size,
    byType,
  }
}

function normalizeIdentity(value) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function libraryMatch(reference, library) {
  const doi = normalized(reference?.doi)
  const arxiv = normalized(reference?.arxiv)
  const title = normalizeIdentity(reference?.title)
  return (
    (Array.isArray(library) ? library : []).find(
      (paper) =>
        (doi && normalized(paper.doi) === doi) ||
        (arxiv && normalized(paper.arxiv) === arxiv) ||
        (title && normalizeIdentity(paper.title) === title),
    ) || null
  )
}

export function buildCitationGraph({ centerJobId, center, references, incomingReferences, library }) {
  const centerPaper =
    (Array.isArray(library) ? library : []).find((paper) => paper.jobId === centerJobId) || {
      jobId: centerJobId,
      title: center?.title || centerJobId,
      authors: center?.authors || '',
      doi: center?.doi || '',
      arxiv: center?.arxiv || '',
    }
  const nodes = [
    {
      id: 'job:' + centerJobId,
      type: 'center',
      title: centerPaper.title,
      authors: centerPaper.authors || '',
      doi: centerPaper.doi || '',
      arxiv: centerPaper.arxiv || '',
      localJobId: centerJobId,
      oaStatus: 'local',
    },
  ]
  const edges = []
  let outgoingLocal = 0
  for (const [index, reference] of (Array.isArray(references) ? references : []).entries()) {
    const matched = libraryMatch(reference, library)
    if (matched) outgoingLocal += 1
    const key = reference.doi || reference.arxiv || normalizeIdentity(reference.title) || 'ref-' + (index + 1)
    const id = 'cite:' + key
    nodes.push({
      id,
      type: 'outgoing',
      title: reference.title || clip(reference.text, 160) || '参考文献 ' + (index + 1),
      authors: reference.authors || '',
      doi: reference.doi || '',
      arxiv: reference.arxiv || '',
      localJobId: matched?.jobId || '',
      oaStatus: matched ? 'local' : reference.oaStatus || 'unknown',
      referenceNumber: Number(reference.number) || index + 1,
      blockId: reference.blockId || '',
    })
    edges.push({
      id: 'edge-out-' + index,
      from: 'job:' + centerJobId,
      to: id,
      type: 'references',
      grounded: Boolean(reference.blockId),
      blockId: reference.blockId || '',
    })
  }
  const incomingJobs = new Set()
  let incomingLocalReferences = 0
  for (const [index, item] of (Array.isArray(incomingReferences) ? incomingReferences : []).entries()) {
    const citingJobId = String(item?.citingJobId || '')
    if (!citingJobId || citingJobId === centerJobId) continue
    const paper = library.find((entry) => entry.jobId === citingJobId)
    if (!paper) continue
    incomingLocalReferences += 1
    incomingJobs.add(citingJobId)
    const id = 'job:' + citingJobId
    if (!nodes.some((node) => node.id === id)) {
      nodes.push({
        id,
        type: 'incoming',
        title: paper.title,
        authors: paper.authors || '',
        doi: paper.doi || '',
        arxiv: paper.arxiv || '',
        localJobId: citingJobId,
        oaStatus: 'local',
      })
    }
    edges.push({
      id: 'edge-in-' + index,
      from: id,
      to: 'job:' + centerJobId,
      type: 'cites-current',
      grounded: Boolean(item.blockId),
      blockId: item.blockId || '',
      referenceNumber: Number(item.number) || 0,
    })
  }
  return {
    centerJobId,
    nodes,
    edges,
    coverage: {
      outgoing: Array.isArray(references) ? references.length : 0,
      outgoingLocal,
      incomingLocal: incomingJobs.size,
      incomingLocalReferences,
      externalIncoming: 'not-indexed',
    },
    warnings:
      incomingJobs.size === 0
        ? ['外部施引关系未做全库检索；当前图谱只展示本地论文之间的已知引用。']
        : [],
  }
}

export function buildKnowledgeProfile({ library, profile, annotationsByJob, reviewByJob, archives }) {
  const papers = Array.isArray(library) ? library : []
  const reading = profile?.jobs && typeof profile.jobs === 'object' ? profile.jobs : {}
  const paperProfiles = papers.map((paper) => {
    const record = reading[paper.jobId] || {}
    return {
      jobId: paper.jobId,
      title: paper.title,
      readingSeconds: Math.max(0, Number(record.readingSeconds) || 0),
      lastReadAt: record.lastReadAt || '',
      lastBlockId: record.lastBlockId || '',
      lastPage: Number(record.lastPage) || 0,
      lastSection: record.lastSection || '',
      visitedBlockIds: Array.isArray(record.visitedBlockIds) ? record.visitedBlockIds.slice(-80) : [],
      annotationCount: Number(annotationsByJob?.[paper.jobId]?.count) || 0,
      pendingAnnotations: Number(annotationsByJob?.[paper.jobId]?.pending) || 0,
      reviewPending: Number(reviewByJob?.[paper.jobId]) || 0,
    }
  })
  const totalReadingSeconds = paperProfiles.reduce((sum, paper) => sum + paper.readingSeconds, 0)
  const nextActions = []
  for (const paper of paperProfiles) {
    if (paper.pendingAnnotations > 0) {
      nextActions.push({
        type: 'pending-annotation',
        jobId: paper.jobId,
        title: paper.title,
        text: paper.pendingAnnotations + ' 条批注尚未发送给模型',
      })
    }
    if (paper.reviewPending > 0) {
      nextActions.push({
        type: 'review',
        jobId: paper.jobId,
        title: paper.title,
        text: paper.reviewPending + ' 条译文复核问题待核对',
      })
    }
  }
  return {
    totalReadingSeconds,
    papersRead: paperProfiles.filter((paper) => paper.readingSeconds > 0 || paper.lastReadAt).length,
    papers: paperProfiles.sort((left, right) =>
      String(right.lastReadAt).localeCompare(String(left.lastReadAt)),
    ),
    pendingAnnotations: paperProfiles.reduce((sum, paper) => sum + paper.pendingAnnotations, 0),
    reviewPending: paperProfiles.reduce((sum, paper) => sum + paper.reviewPending, 0),
    archives: Array.isArray(archives) ? archives.length : 0,
    nextActions: nextActions.slice(0, 20),
  }
}

function csvCell(value) {
  const text = String(value ?? '')
  return '"' + text.replace(/"/g, '""') + '"'
}

export function glossaryToCsv(entries) {
  const lines = ['source,target,kind,count,locked,blockId']
  for (const entry of Array.isArray(entries) ? entries : []) {
    lines.push(
      [
        entry.source,
        entry.target,
        entry.kind,
        Number(entry.count) || 1,
        entry.locked ? 'true' : 'false',
        entry.firstBlockId || '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

export function annotationsToJson({ jobId, paper, items }) {
  const warnings = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!Array.isArray(item?.segments) || item.segments.length === 0) {
      warnings.push('批注 ' + (item?.id || '?') + ' 没有原文片段')
    }
    for (const segment of item?.segments || []) {
      if (!segment?.blockId) warnings.push('批注 ' + (item?.id || '?') + ' 缺少 blockId')
    }
  }
  return {
    json: JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        jobId,
        paper: paper || null,
        warnings,
        items: Array.isArray(items) ? items : [],
      },
      null,
      2,
    ),
    warnings,
  }
}

export function annotationsToMarkdown({ jobId, paper, items }) {
  const warnings = []
  const lines = ['# ' + (paper?.title || jobId) + ' · 批注', '']
  lines.push('- 论文：' + (paper?.title || jobId))
  lines.push('- jobId：' + jobId)
  lines.push('- 导出时间：' + new Date().toISOString())
  lines.push('- 批注数：' + (Array.isArray(items) ? items.length : 0))
  lines.push('')
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    lines.push('## ' + (index + 1) + '. ' + (item.question || '仅标记'))
    if (Array.isArray(item.segments) && item.segments.length > 0) {
      for (const segment of item.segments) {
        if (!segment.blockId) warnings.push('批注 ' + (item.id || index + 1) + ' 缺少 blockId')
        lines.push(
          '- 位置：' +
            (segment.section || '正文') +
            ' · p.' +
            (segment.page || '?') +
            (segment.blockId ? ' · ' + segment.blockId : ''),
        )
        if (segment.quote) lines.push('  > ' + String(segment.quote).replace(/\n/g, '\n  > '))
      }
    } else {
      warnings.push('批注 ' + (item.id || index + 1) + ' 没有原文片段')
    }
    lines.push('')
  }
  if (warnings.length > 0) lines.push('## 导出告警', ...warnings.map((warning) => '- ' + warning), '')
  return { markdown: lines.join('\n').trim() + '\n', warnings }
}

export function citationsToMarkdown({ jobId, paper, references, analyses }) {
  const refs = Array.isArray(references) ? references : []
  const lines = ['# ' + (paper?.title || jobId) + ' · 引用汇总', '']
  lines.push('- 论文：' + (paper?.title || jobId))
  lines.push('- jobId：' + jobId)
  lines.push('- 参考文献数：' + refs.length)
  lines.push('- 引用分析卡：' + (Array.isArray(analyses) ? analyses.length : 0))
  lines.push('', '## 参考文献')
  for (const [index, reference] of refs.entries()) {
    lines.push(
      [
        index + 1 + '.',
        reference.title || '',
        reference.doi ? 'DOI ' + reference.doi : '',
        reference.arxiv ? 'arXiv ' + reference.arxiv : '',
        reference.blockId ? '[' + reference.blockId + ']' : '（无 blockId）',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  if (Array.isArray(analyses) && analyses.length > 0) {
    lines.push('', '## 已缓存引用分析')
    for (const analysis of analyses.slice(0, 80)) {
      lines.push(
        '- ' +
          (analysis.title || analysis.metadata?.title || '引用分析') +
          (analysis.basis ? ' · ' + analysis.basis : ''),
      )
    }
  }
  return lines.join('\n').trim() + '\n'
}
