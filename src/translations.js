// 论文翻译的纯逻辑层：分段、任务、提示词、校验与装配。
//
// 翻译单位不是整段，而是“语义小段”：1–3 句、约 360 字符以内。
// 这样中文模式和对照模式共用同一份切分，对照时能按小段交替，而不是
// 一大段英文接一大段中文。

import { createHash } from 'node:crypto'
import { parseCitationSpans } from './citations.js'

export const TRANSLATION_PROMPT_VERSION = 4
export const DEFAULT_TARGET_LANG = 'zh-CN'
const MAX_SEGMENT_CHARS = 360
const MAX_SEGMENT_SENTENCES = 3

const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'et al.',
  'fig.',
  'eq.',
  'vs.',
  'dr.',
  'mr.',
  'ms.',
  'no.',
  'cf.',
  'sec.',
  'ref.',
  'approx.',
])

function cleanSlice(text, start, end) {
  let left = start
  let right = end
  while (left < right && /\s/.test(text[left])) left += 1
  while (right > left && /\s/.test(text[right - 1])) right -= 1
  return { start: left, end: right, source: text.slice(left, right) }
}

function sentenceRanges(text) {
  const ranges = []
  let start = 0
  const re = /[.!?](?=\s+[A-Z0-9(\[])/g
  let match
  while ((match = re.exec(text))) {
    const before = text.slice(start, match.index + 1).trim().split(/\s+/).slice(-3).join(' ').toLowerCase()
    const lastWord = before.split(/\s+/).pop() || ''
    if (ABBREVIATIONS.has(lastWord)) continue
    ranges.push([start, match.index + 1])
    start = match.index + 1
  }
  if (start < text.length) ranges.push([start, text.length])
  return ranges.length ? ranges : [[0, text.length]]
}

function hardSplit(text, start, end, maxChars) {
  const pieces = []
  let cursor = start
  while (cursor < end) {
    let next = Math.min(end, cursor + maxChars)
    if (next < end) {
      const space = text.lastIndexOf(' ', next)
      if (space > cursor + maxChars * 0.55) next = space
    }
    const piece = cleanSlice(text, cursor, next)
    if (piece.source) pieces.push(piece)
    cursor = next
  }
  return pieces
}

/**
 * 把一个块拆成语义小段；返回的 start/end 是原 block.text 的绝对偏移。
 * 对照模式直接用这些偏移把引用 span 映射进每个 source 小段。
 */
export function splitSegments(text, { maxChars = MAX_SEGMENT_CHARS, maxSentences = MAX_SEGMENT_SENTENCES } = {}) {
  const source = String(text ?? '').trim()
  if (!source) return []
  const ranges = sentenceRanges(source)
  const pieces = []
  let current = null
  let sentenceCount = 0
  const flush = () => {
    if (current) pieces.push(cleanSlice(source, current[0], current[1]))
    current = null
    sentenceCount = 0
  }
  for (const [start, end] of ranges) {
    const length = end - start
    if (length > maxChars) {
      flush()
      pieces.push(...hardSplit(source, start, end, maxChars))
      continue
    }
    const nextLength = current ? end - current[0] : length
    if (current && (nextLength > maxChars || sentenceCount >= maxSentences)) flush()
    current = current ? [current[0], end] : [start, end]
    sentenceCount += 1
  }
  flush()
  return pieces
    .filter((piece) => piece.source)
    .map((piece, index) => ({ id: index, ...piece }))
}

function addUnit(units, { key, blockId, type, text }) {
  const source = String(text ?? '').trim()
  if (!source) return
  const segments = splitSegments(source).map((segment, index) => ({
    ...segment,
    taskId: key + ':' + index,
  }))
  if (!segments.length) return
  units.push({ key, blockId, type, source, segments })
}

/**
 * 从 MirrorDoc 生成翻译单位。
 * 只翻 prose/heading/caption；代码与参考文献保留原文。
 */
export function buildTranslationUnits(doc) {
  const units = []
  const meta = doc?.meta || {}
  addUnit(units, { key: 'meta:title', blockId: '__meta_title', type: 'title', text: meta.title })
  addUnit(units, { key: 'meta:abstract', blockId: '__meta_abstract', type: 'abstract', text: meta.abstract })
  let skipped = 0
  for (const block of doc?.blocks || []) {
    const type = block?.type
    if (Array.isArray(block?.qualityWarning) && block.qualityWarning.length > 0) {
      skipped += 1
      continue
    }
    if (type === 'heading' || type === 'paragraph') {
      addUnit(units, { key: block.id, blockId: block.id, type, text: block.text })
      continue
    }
    if (type === 'caption') {
      addUnit(units, { key: block.id, blockId: block.id, type: 'caption', text: block.text })
      continue
    }
    if (type === 'figure' || type === 'table') {
      const caption = block.caption || block.text || ''
      addUnit(units, { key: block.id, blockId: block.id, type: 'caption', text: caption })
      continue
    }
    if (type === 'reference' || type === 'code' || type === 'equation') skipped += 1
  }
  return { units, skipped }
}

export function flattenTasks(units) {
  return units.flatMap((unit) =>
    unit.segments.map((segment) => ({
      taskId: segment.taskId,
      unitKey: unit.key,
      blockId: unit.blockId,
      type: unit.type,
      text: segment.source,
    })),
  )
}

export function chunkTasks(tasks, { maxTasks = 8, maxChars = 2200 } = {}) {
  const batches = []
  let current = []
  let chars = 0
  for (const task of tasks) {
    if (current.length && (current.length >= maxTasks || chars + task.text.length > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(task)
    chars += task.text.length
  }
  if (current.length) batches.push(current)
  return batches
}

export function translationCacheKey(
  text,
  {
    targetLang = DEFAULT_TARGET_LANG,
    model = '',
    promptVersion = TRANSLATION_PROMPT_VERSION,
    glossaryHash = '',
  } = {},
) {
  return createHash('sha256')
    .update([targetLang, model, promptVersion, glossaryHash, String(text ?? '')].join('\u0000'))
    .digest('hex')
}

export function buildTranslationPrompt({ targetLang = DEFAULT_TARGET_LANG, glossary = [] } = {}) {
  const terms = glossary
    .map((entry) => `- ${String(entry.src || '').replace(/\s+/g, ' ')} → ${String(entry.dst || '').replace(/\s+/g, ' ')}`)
    .join('\n')
  return [
    '你是学术论文翻译引擎，目标语言：' + targetLang + '。',
    '忠实度优先级：技术含义 > 逻辑强度 > 术语一致 > 结构可追溯 > 中文流畅 > 文采。',
    '规则：',
    '1. 逐条翻译；不得合并或拆分输入条目；每条输出独立译文。',
    '2. 保留所有 [n]、[n,m]、[n–m] 引用标记，位置和数字不得改变。',
    '输入中的 ⟦C0⟧、⟦C1⟧ 是引用占位符，必须原样保留；不要翻译或删除。',
    '3. 保留数字、单位、百分位、比较基线、公式符号、变量名、URL、DOI、arXiv ID。',
    '4. 保留 may/can/should/must 等情态强度；is associated with 不得译成 causes。',
    '5. 代码、伪代码、参考文献条目、图表内部文字不翻译（这些不会进入输入）。',
    '6. 首次出现术语可双语括注，之后保持一致。',
    terms ? '7. 术语表（优先遵守）：\n' + terms : '7. 本批无固定术语表。',
    '只返回 JSON 对象：键为输入 id，值为译文；不得缺键，不得输出 Markdown。',
  ].join('\n')
}

/** 把引用标记换成模型不容易改写的占位符；返回原文标记表。 */
export function protectCitations(text) {
  const source = String(text ?? '')
  const spans = parseCitationSpans(source)
  if (!spans.length) return { text: source, markers: [] }
  let cursor = 0
  let protectedText = ''
  const markers = []
  for (const span of spans) {
    protectedText += source.slice(cursor, span.start)
    const token = '⟦C' + markers.length + '⟧'
    markers.push(span.raw)
    protectedText += token
    cursor = span.end
  }
  protectedText += source.slice(cursor)
  return { text: protectedText, markers }
}

/** 恢复引用标记；模型漏掉时把缺失标记补在译文末尾并返回 warning。 */
export function restoreCitations(target, markers) {
  let text = String(target ?? '')
  const missing = []
  markers.forEach((marker, index) => {
    const token = '⟦C' + index + '⟧'
    if (text.includes(token)) text = text.split(token).join(marker)
    else missing.push(marker)
  })
  if (missing.length) text = text.trimEnd() + ' ' + missing.join(' ')
  return { text: text.trim(), warnings: missing.length ? ['restored-citations:' + missing.join('')] : [] }
}

export function parseTranslationResponse(content, expectedIds) {
  let value = String(content ?? '').trim()
  value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('translation response is not a JSON object')
  }
  const out = new Map()
  for (const id of expectedIds) {
    const text = parsed[id]
    if (typeof text !== 'string' || !text.trim()) throw new Error('translation response missing/invalid id ' + id)
    out.set(id, text.trim())
  }
  return out
}

export function validateTranslation(source, target) {
  const warnings = []
  const sourceCitations = [...String(source).matchAll(/\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g)].map((m) => m[0])
  const targetCitations = [...String(target).matchAll(/\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g)].map((m) => m[0])
  if (sourceCitations.join('|') !== targetCitations.join('|')) warnings.push('citation-markers')
  const sourceNumbers = numericValues(source)
  const targetNumbers = numericValues(target)
  const missing = sourceNumbers.filter((number) => !targetNumbers.includes(number))
  if (missing.length) warnings.push('numbers:' + missing.slice(0, 5).join(','))
  return warnings
}

const SCALE = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  百: 1e2,
  千: 1e3,
  万: 1e4,
  亿: 1e8,
}

/** 把 200 million / 2亿 归一成可比较的数值，避免中文数词造成假告警。 */
function numericValues(text) {
  const values = []
  for (const match of String(text ?? '').matchAll(/(\d+)\s*世纪\s*(\d+)\s*年代/g)) {
    const value = (Number(match[1]) - 1) * 100 + Number(match[2])
    values.push(String(value))
  }
  const re = /(\d+(?:\.\d+)?)(?:\s*(thousand|million|billion|百|千|万|亿))?/gi
  let match
  while ((match = re.exec(String(text ?? '')))) {
    const value = Number(match[1])
    const scale = match[2] ? SCALE[match[2].toLowerCase()] || 1 : 1
    const normalized = value * scale
    values.push(Number.isInteger(normalized) ? String(normalized) : String(Number(normalized.toFixed(4))))
  }
  return [...new Set(values)]
}

const CJK_RE = /[\u3400-\u9fff]/
const ENGLISH_PROSE_HINT_RE =
  /\b(?:a|an|the|and|or|of|to|in|on|for|from|with|by|is|are|was|were|has|have|that|this|these|those|it|as|at|be)\b/i

/** 翻译质量闸门：空译、未翻译、无中文、引用/数字、术语命中。 */
export function auditTranslations({ blocks = {}, meta = {}, glossary = [] } = {}) {
  const warnings = []
  const errors = []
  const units = []
  if (meta.title) units.push({ id: 'meta:title', source: meta.title, segments: meta.titleSegments || [] })
  if (meta.abstract) {
    units.push({ id: 'meta:abstract', source: meta.abstract, segments: meta.abstractSegments || [] })
  }
  for (const [blockId, block] of Object.entries(blocks)) {
    if (block?.type === 'equation') continue
    units.push({ id: blockId, source: block.source || '', segments: block.segments || [] })
  }
  const termEntries = Array.isArray(glossary) ? glossary : []
  for (const unit of units) {
    for (const segment of unit.segments) {
      const source = String(segment.source || '')
      const target = String(segment.target || '').trim()
      const id = segment.taskId || unit.id
      if (!target) {
        errors.push({ id, kind: 'empty-translation' })
        continue
      }
      if (target === source) warnings.push({ id, kind: 'untranslated' })
      if (
        source.length > 24 &&
        /[A-Za-z]{4}/.test(source) &&
        ENGLISH_PROSE_HINT_RE.test(source) &&
        !CJK_RE.test(target)
      ) {
        warnings.push({ id, kind: 'no-cjk' })
      }
      for (const issue of validateTranslation(source, target)) {
        warnings.push({ id, kind: issue })
      }
      for (const term of termEntries) {
        const src = String(term.source || '')
        const dst = String(term.target || '')
        if (!src || !source.includes(src)) continue
        if (term.locked && !target.includes(src)) warnings.push({ id, kind: 'locked-term-missing:' + src })
        if (!term.locked && dst && !target.includes(dst) && !target.includes(src)) {
          warnings.push({ id, kind: 'glossary-miss:' + src })
        }
      }
    }
  }
  return {
    status: errors.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    errors,
    warnings,
    counts: {
      units: units.length,
      segments: units.reduce((sum, unit) => sum + unit.segments.length, 0),
      errors: errors.length,
      warnings: warnings.length,
    },
  }
}

export function assembleTranslations({ units, translations, model, targetLang = DEFAULT_TARGET_LANG, warnings = [] }) {
  const meta = {}
  const blocks = {}
  let translated = 0
  let failed = 0
  for (const unit of units) {
    const segments = unit.segments.map((segment) => {
      const target = translations.get(segment.taskId) || ''
      if (!target) failed += 1
      else translated += 1
      return { ...segment, target, targetSpans: parseCitationSpans(target) }
    })
    const text = segments.map((segment) => segment.target).filter(Boolean).join(' ')
    const payload = { type: unit.type, source: unit.source, text, segments }
    if (unit.key === 'meta:title') {
      meta.title = text
      meta.titleSegments = segments
    }
    else if (unit.key === 'meta:abstract') {
      meta.abstract = text
      meta.abstractSegments = segments
    } else blocks[unit.blockId] = payload
  }
  return {
    version: 1,
    targetLang,
    model,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    meta,
    blocks,
    coverage: {
      units: units.length,
      segments: units.reduce((sum, unit) => sum + unit.segments.length, 0),
      translated,
      failed,
    },
    warnings,
  }
}
