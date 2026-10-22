// 引用蓝链与引用预览的纯逻辑层。
//
// 这里不碰文件、不联网：
//   - 从正文识别 [12] / [12,13] / [12–14]
//   - 建立引用编号 ↔ 参考文献块 ↔ 正文块的位置索引
//   - 从 reference 文本里提取 DOI / arXiv / 年份 / 标题提示
//   - 把被引论文压成紧凑摘要，并构造"概览 + 与引用处关系"的模型提示词
//
// 浏览器半区只消费这里产出的 spans；不在前端复制第二套正则（AGENTS §3）。

import { createHash } from 'node:crypto'
import { normalizeArxiv, normalizeDoi, parseIdentifiers } from './identifiers.js'

const CITATION_GROUP_RE = /\[([0-9][0-9\s,–\-]*)\]/g
const REFERENCE_NUMBER_RE = /^\s*\[?(\d{1,4})[\].)]\s+/
const MAX_DIGEST_CHARS = 9000
const MAX_RANGE = 40
export const CITATION_ANALYSIS_VERSION = 3

function uniqueNumbers(numbers) {
  const seen = new Set()
  return numbers.filter((number) => {
    if (seen.has(number)) return false
    seen.add(number)
    return true
  })
}

/** 解析一个方括号组里的编号；[3–5] 会展开成 3,4,5。 */
export function parseCitationNumbers(inside) {
  const numbers = []
  for (const part of String(inside ?? '').split(',')) {
    const range = part.trim().match(/^(\d{1,4})\s*[–-]\s*(\d{1,4})$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > 0 && end >= start && end - start <= MAX_RANGE) {
        for (let number = start; number <= end; number += 1) numbers.push(number)
      } else {
        numbers.push(start, end)
      }
      continue
    }
    const single = part.trim().match(/^(\d{1,4})$/)
    if (single) numbers.push(Number(single[1]))
  }
  return uniqueNumbers(numbers.filter((number) => number > 0))
}

/** 找出正文块里的引用 span；保留原文偏移，前端只负责切片和渲染。 */
export function parseCitationSpans(text) {
  const source = String(text ?? '')
  const spans = []
  CITATION_GROUP_RE.lastIndex = 0
  let match
  while ((match = CITATION_GROUP_RE.exec(source))) {
    const numbers = parseCitationNumbers(match[1])
    if (numbers.length === 0) continue
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      numbers,
    })
  }
  return spans
}

/** 参考文献块开头的编号；只认行首，避免把年份当编号。 */
export function referenceNumber(text) {
  const match = String(text ?? '').match(REFERENCE_NUMBER_RE)
  return match ? Number(match[1]) : 0
}

/**
 * 建立一篇 MirrorDoc 的引用索引。
 * @param {Array<object>} blocks - MirrorDoc blocks。
 * @returns {object} references / byBlock / unresolved。
 */
export function buildCitationIndex(blocks = []) {
  const references = []
  const byNumber = new Map()
  for (const block of blocks) {
    if (block?.type !== 'reference') continue
    const number = referenceNumber(block.text)
    if (!number || byNumber.has(number)) continue
    const entry = {
      number,
      blockId: block.id || '',
      page: Number(block.page) || 0,
      text: String(block.text || '').trim(),
    }
    byNumber.set(number, entry)
    references.push(entry)
  }
  references.sort((a, b) => a.number - b.number)

  const byBlock = {}
  const unresolved = []
  for (const block of blocks) {
    const type = block?.type
    if (!['paragraph', 'heading', 'caption'].includes(type)) continue
    const spans = parseCitationSpans(block.text)
    if (spans.length === 0) continue
    const resolved = []
    for (const span of spans) {
      const numbers = span.numbers.filter((number) => byNumber.has(number))
      if (numbers.length === 0) {
        unresolved.push({ blockId: block.id || '', raw: span.raw, numbers: span.numbers })
        continue
      }
      resolved.push({ ...span, numbers })
    }
    if (resolved.length > 0) byBlock[block.id || ''] = resolved
  }
  return {
    version: 1,
    references,
    byBlock,
    unresolved,
    referenceCount: references.length,
  }
}

function cleanReferenceText(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\[CrossRef\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeAuthorList(value) {
  const text = String(value || '').trim()
  if (!text || text.length > 180) return false
  const initials = (text.match(/\b[A-Z][a-z]?\./g) || []).length
  return initials >= 2 || /;\s*[A-Z]/.test(text) || /\band\b/i.test(text)
}

function guessTitle(segments, authors = '') {
  const candidates = segments
    .map((segment) => segment.trim())
    .filter((segment) => {
      const words = segment.split(/\s+/).filter(Boolean)
      return (
        segment.length >= 12 &&
        words.length >= 3 &&
        /[A-Za-z]{4}/.test(segment) &&
        !(
          (segment.match(/,/g) || []).length >= 4 &&
          /\band\b/i.test(segment)
        ) &&
        !/^(?:journal|proceedings|vol\.?|pp\.?|doi|https?:|available|retrieved|isbn|arxiv preprint|in proceedings|in findings|in advances)\b/i.test(
          segment,
        ) &&
        segment !== authors
      )
    })
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0] || segments[1] || segments[0] || ''
}

/**
 * 从一条 reference 文本提取可查询字段。
 * 不追求完美解析；查不准时用户可以在查询页改字段。
 */
export function extractReferenceFields(text) {
  const raw = cleanReferenceText(text)
  const identifiers = parseIdentifiers(raw)
  const withoutNumber = raw.replace(REFERENCE_NUMBER_RE, '').trim()
  const withoutDoi = withoutNumber
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bdoi:\s*\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const years = [...withoutDoi.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => match[0])
  const parenthetical = withoutDoi.match(/\((?:19|20)\d{2}[a-z]?\)/)
  const segments = withoutDoi
    .split(/\.\s+/)
    .map((segment) => segment.trim().replace(/[.;]+$/, ''))
    .filter((segment) => segment.length > 3)
  let authors = ''
  let title = ''
  let venue = ''
  if (parenthetical) {
    authors = withoutDoi.slice(0, parenthetical.index).trim().replace(/[.,;]+$/, '')
    const after = withoutDoi
      .slice(parenthetical.index + parenthetical[0].length)
      .trim()
      .replace(/^[.:;,\-–—\s]+/, '')
    title = after.split(/\.\s+/)[0].trim()
    venue = after.split(/\.\s+/).slice(1).find(Boolean) || ''
  }
  if (!title || title.length < 8) {
    const authorLike = segments[0] && looksLikeAuthorList(segments[0]) ? segments[0] : ''
    authors = authors || authorLike
    title = guessTitle(segments, authors)
  }
  if (looksLikeAuthorList(title)) {
    const replacement = guessTitle(segments, authors)
    if (replacement && replacement !== title) title = replacement
  }
  if (/^(?:arxiv preprint|available online|in proceedings|in findings)\b/i.test(title)) {
    const replacement = guessTitle(segments, authors)
    if (replacement) title = replacement
  }
  const titleKey = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const titleIndex = segments.findIndex((segment) => {
    const segmentKey = segment.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return titleKey && (segmentKey.includes(titleKey) || titleKey.includes(segmentKey))
  })
  if (!venue && titleIndex >= 0) {
    venue =
      segments.slice(titleIndex + 1).find(
        (segment) =>
          segment.length >= 3 &&
          !/^(?:doi|https?:|vol\.?|pp\.?|isbn|available|retrieved)\b/i.test(segment),
      ) || ''
  }
  title = title
    .replace(
      /\s*,?\s*(?:CoRR|arXiv)\s*,?\s*(?:abs\/)?\d{4}\.\d{4,5}(?:v\d+)?(?:\s*,?\s*(?:19|20)\d{2}[a-z]?)?\s*,?\s*$/i,
      '',
    )
    .replace(/\s*\(?(?:19|20)\d{2}[a-z]?\)?.*$/, '')
    .trim()
    .slice(0, 320)
  authors = authors.replace(/^\d+[.)]\s*/, '').trim().slice(0, 320)
  const year = years.length ? years[years.length - 1] : ''
  venue = cleanReferenceText(venue)
    .replace(/\s+\d+\s*(?:\(\d+\))?\s*[,:].*$/, '')
    .replace(/\s+\d+\s*[-–]\s*\d+.*$/, '')
    .trim()
    .slice(0, 180)
  return {
    raw,
    text: raw,
    doi: identifiers.doi || normalizeDoi(raw) || '',
    arxiv: identifiers.arxiv || normalizeArxiv(raw) || '',
    title,
    authors,
    venue,
    year,
    query: title.slice(0, 700) || withoutDoi.slice(0, 700),
  }
}

/** 把被引论文压成给模型看的摘要；优先用 MirrorDoc 的章节正文。 */
export function buildCitedDigest({ doc, summary, abstract = '' } = {}) {
  const meta = doc?.meta || {}
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : []
  const lines = []
  let paragraphBlocks = 0
  let currentHeading = ''
  let inSectionParagraphs = 0
  for (const block of blocks) {
    if (block?.type === 'heading') {
      currentHeading = String(block.text || '').trim()
      inSectionParagraphs = 0
      if (currentHeading) lines.push('\n[' + currentHeading + ']')
      continue
    }
    if (block?.type !== 'paragraph') continue
    paragraphBlocks += 1
    if (inSectionParagraphs >= 3) continue
    const text = String(block.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(text.slice(0, 700))
    inSectionParagraphs += 1
  }
  const summarySections = Array.isArray(summary?.sections) ? summary.sections : []
  if (lines.length === 0 && summarySections.length > 0) {
    for (const section of summarySections) {
      lines.push('\n[' + String(section.heading || '') + ']')
      if (section.gist) lines.push(String(section.gist).slice(0, 700))
    }
  }
  const abstractText = String(summary?.abstract || meta.abstract || abstract || '').replace(/\s+/g, ' ').trim()
  const title = String(summary?.title || meta.title || '').trim()
  const text = [
    title ? 'TITLE: ' + title : '',
    abstractText ? 'ABSTRACT: ' + abstractText.slice(0, 1800) : '',
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_DIGEST_CHARS)
  return {
    title,
    abstract: abstractText,
    text,
    basis: paragraphBlocks > 0 ? 'full-text' : abstractText ? 'abstract' : 'metadata',
    paragraphBlocks,
  }
}

/** 用于缓存分析结果的稳定键；换引用上下文就重新生成。 */
export function citationContextHash({ jobId, blockId, quote, number, referenceText, referenceKey = '' }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        jobId,
        blockId,
        quote,
        number,
        referenceText,
        referenceKey,
        version: CITATION_ANALYSIS_VERSION,
      }),
    )
    .digest('hex')
    .slice(0, 20)
}

const STANCES = new Set(['supports', 'contrasts', 'method', 'background', 'mixed', 'unclear'])

/** 规范模型输出，保证前端拿到的形状稳定。 */
export function normalizeCitationAnalysis(value) {
  const overview = value?.overview && typeof value.overview === 'object' ? value.overview : {}
  const relation = value?.relation && typeof value.relation === 'object' ? value.relation : {}
  const string = (input, fallback = '') =>
    typeof input === 'string' ? input.trim().slice(0, 1800) : fallback
  const points = Array.isArray(relation.points)
    ? relation.points
        .map((point) => ({
          claim: string(point?.claim),
          citingEvidence: string(point?.citingEvidence),
          citedEvidence: string(point?.citedEvidence),
        }))
        .filter((point) => point.claim || point.citingEvidence || point.citedEvidence)
        .slice(0, 6)
    : []
  return {
    overview: {
      background: string(overview.background),
      question: string(overview.question),
      method: string(overview.method),
      findings: string(overview.findings),
      evidence: string(overview.evidence),
      limitations: string(overview.limitations),
    },
    relation: {
      stance: STANCES.has(relation.stance) ? relation.stance : 'unclear',
      summary: string(relation.summary),
      points,
    },
    warnings: Array.isArray(value?.warnings)
      ? value.warnings.map((warning) => string(warning)).filter(Boolean).slice(0, 6)
      : [],
  }
}

/** 构造"文章概览 + 与引用处关系"的提示词。 */
export function buildCitationPrompt({ referenceText, number, citing, digest }) {
  const system = [
    '你是论文引用审校助手。只根据给定材料工作，不补造事实。',
    '必须把两件事分开：引用者在这一段说了什么；被引论文本身实际说了什么。',
    '引用者的主张不能自动当成被引论文的结论。',
    '只输出 JSON，不要 Markdown。',
  ].join('\n')
  const user = [
    '引用编号：[' + number + ']',
    '当前论文标题：' + (citing?.paperTitle || '（未知）'),
    '引用处章节：' + (citing?.section || '（未知）'),
    '引用处页码：' + (citing?.page || '（未知）'),
    '引用处原文：' + (citing?.quote || '（未提供）'),
    '引用处前文：' + (citing?.before || '（未提供）'),
    '引用处后文：' + (citing?.after || '（未提供）'),
    '',
    '参考文献原文：',
    referenceText || '（未提供）',
    '',
    '被引论文材料（' + digest.basis + '）：',
    digest.text || '（只有元数据）',
    '',
    '请返回：',
    '{',
    '  "overview": {"background": "...", "question": "...", "method": "...", "findings": "...", "evidence": "...", "limitations": "..."},',
    '  "relation": {"stance": "supports|contrasts|method|background|mixed|unclear",',
    '               "summary": "...",',
    '               "points": [{"claim": "...", "citingEvidence": "...", "citedEvidence": "..."}]},',
    '  "warnings": ["..."]',
    '}',
    'overview 每个字段至少 3 句、约 120–220 个汉字；六项合计约 900–1400 字。',
    '不要只写一句概括；有材料时写出具体研究设计、样本量、数据来源、关键数值、比较基线和结论边界。',
    '只有元数据时不要编造细节，但要说明缺什么、因此无法判断什么。',
    'relation.points 给 2–4 条，必须分别指出引用处与被引论文的依据；没有材料支持的内容不要写。',
    '如果材料只有摘要，在 warnings 写明“基于摘要，未核对全文”。',
  ].join('\n')
  return { system, user }
}
