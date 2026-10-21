// 宿主半区：论文术语即时查词。
//
// 这不是生词本：没有收藏、标签、掌握度或跨会话学习记录。
// 查询优先使用论文内缩写定义和当前术语表；缺失时才让模型解释当前语境。

import { createHash } from 'node:crypto'

export const TERM_PROMPT_VERSION = 1
export const MAX_TERM_CHARS = 160

const TERM_KINDS = new Set(['word', 'phrase', 'acronym', 'identifier', 'symbol', 'unknown'])
const CONFIDENCE = new Set(['high', 'medium', 'low', 'unknown'])

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function clip(value, limit) {
  const text = clean(value)
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

function canonical(value) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function cleanExpandedName(value) {
  let text = clean(value)
  const lead = /^(?:a|an|the|this|these|those|first|second|third|new)\s+/i
  while (lead.test(text)) text = text.replace(lead, '')
  return text
}

/**
 * 规范化用户选中的词/短语。整段文字不进入查词接口。
 * @param {unknown} value - 选区文本。
 * @returns {string} 可查询的短词或短语。
 */
export function normalizeSelectedTerm(value) {
  const term = clean(value).replace(/^[\s"'“”‘’([{]+|[\s"'“”‘’)\]}.,;:!?]+$/g, '')
  if (!term) throw Object.assign(new Error('请选择一个词或短语'), { statusCode: 400 })
  if (term.length > MAX_TERM_CHARS) {
    throw Object.assign(new Error('选区太长，请只选择一个词、缩写或短语'), { statusCode: 400 })
  }
  return term
}

/**
 * 从当前段落中取包含所选词的一句；找不到时退回前后文拼接。
 * @param {string} text - 当前段落/摘要。
 * @param {string} term - 选中词。
 * @param {string} [before] - 选区前文。
 * @param {string} [after] - 选区后文。
 * @returns {string} 约一句话的语境。
 */
export function extractTermSentence(text, term, before = '', after = '') {
  const source = clean(text)
  const wanted = clean(term)
  const index = source.toLowerCase().indexOf(wanted.toLowerCase())
  if (index >= 0) {
    const starts = [0]
    const ends = []
    const ignored = new Set([
      'e.g.',
      'i.e.',
      'al.',
      'fig.',
      'figs.',
      'eq.',
      'eqs.',
      'ref.',
      'refs.',
      'vs.',
      'no.',
      'nos.',
      'dr.',
      'prof.',
      'approx.',
    ])
    const boundary = /[.!?。！？]/g
    let match
    while ((match = boundary.exec(source))) {
      const at = match.index
      const next = source[at + 1] || ''
      if (next && !/\s/.test(next)) continue
      const word = source
        .slice(Math.max(0, at - 16), at + 1)
        .match(/([A-Za-z][A-Za-z.]*)$/)?.[1]
      if (word && ignored.has(word.toLowerCase())) continue
      if (word && /^[A-Z]\.$/.test(word)) continue
      const whitespace = source.slice(at + 1).match(/^\s+/)?.[0] || ''
      const end = at + 1 + whitespace.length
      starts.push(end)
      ends.push(end)
    }
    ends.push(source.length)
    const start = [...starts].reverse().find((value) => value <= index) ?? 0
    const end = ends.find((value) => value >= index + wanted.length) ?? source.length
    const sentence = clean(source.slice(start, end))
    if (sentence) return clip(sentence, 620)
  }
  const fallback = clean([before, wanted, after].filter(Boolean).join(' '))
  return clip(fallback || wanted, 620)
}

/** 粗略判断选区类型；最终仍以模型和论文证据为准。 */
export function classifyTerm(term) {
  const text = clean(term)
  const letters = text.replace(/[^\p{L}]/gu, '')
  const upper = text.replace(/[^\p{Lu}]/gu, '')
  if (/^[A-Z][A-Z0-9/+.-]{1,20}$/.test(text) && upper.length >= Math.max(2, letters.length * 0.6)) {
    return 'acronym'
  }
  if (/[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*/.test(text)) return 'identifier'
  if (/^[^\p{L}\p{N}]+$/u.test(text)) return 'symbol'
  if (text.split(/\s+/).length > 1) return 'phrase'
  return letters ? 'word' : 'unknown'
}

function blockEvidence(block, quote) {
  return {
    blockId: String(block?.id || ''),
    page: Number(block?.page) || 0,
    section: clip(block?.section || '', 100),
    quote: clip(quote, 240),
  }
}

/**
 * 在论文中查找缩写定义和术语表。返回确定性证据，不调用模型。
 * @param {{term: string, blocks?: object[], glossary?: object[], preferredBlockId?: string}} options - 查询材料。
 * @returns {{kind: string, glossaryTarget: string, expanded: string, abbreviation: string, evidence: object|null, glossaryEntryId: string}}
 */
export function findLocalTermEvidence({ term, blocks = [], glossary = [], preferredBlockId = '' }) {
  const wanted = normalizeSelectedTerm(term)
  const wantedKey = canonical(wanted)
  const glossaryEntry = (Array.isArray(glossary) ? glossary : []).find(
    (entry) => canonical(entry?.source) === wantedKey,
  )
  const definitions = []
  const definitionKeys = new Set()
  const addDefinition = (fullName, acronym, block, quote) => {
    const expanded = cleanExpandedName(fullName)
    const abbreviation = clean(acronym)
    const key = canonical(expanded) + '|' + canonical(abbreviation)
    if (!expanded || definitionKeys.has(key)) return
    definitionKeys.add(key)
    definitions.push({
      expanded,
      abbreviation,
      evidence: blockEvidence(block, quote),
    })
  }

  for (const block of (Array.isArray(blocks) ? blocks : []).slice(0, 500)) {
    const text = clean(block?.text || block?.caption || '')
    if (!text) continue
    const parenthesis = /([A-Z][A-Za-z0-9&/+.-]*(?:\s+[A-Za-z0-9&/+.-]+){0,10})\s*\(\s*([A-Z][A-Z0-9/+.-]{1,24})\s*\)/g
    let match
    while ((match = parenthesis.exec(text))) {
      const fullName = cleanExpandedName(match[1])
      const acronym = clean(match[2])
      if (canonical(acronym) === wantedKey) {
        addDefinition(fullName, acronym, block, match[0])
      }
      if (canonical(fullName) === wantedKey) {
        addDefinition(fullName, acronym, block, match[0])
      }
    }

    // 参考文献里的 "NFC Near Field Communication" 这类反向定义。
    const reverse = /\b([A-Z][A-Z0-9/+.-]{1,20})\s+([A-Z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){1,8})/g
    while ((match = reverse.exec(text))) {
      const acronym = clean(match[1])
      const fullName = cleanExpandedName(match[2])
      if (canonical(acronym) === wantedKey) {
        addDefinition(fullName, acronym, block, match[0])
      }
    }
  }

  const preferred = String(preferredBlockId || '')
  if (preferred) {
    definitions.sort(
      (a, b) =>
        Number(b.evidence?.blockId === preferred) - Number(a.evidence?.blockId === preferred),
    )
  }
  const current = definitions[0] || null
  const kind = glossaryEntry?.kind === 'acronym' || definitions.length > 0 ? 'acronym' : classifyTerm(wanted)
  return {
    kind: TERM_KINDS.has(kind) ? kind : 'unknown',
    glossaryTarget: clip(glossaryEntry?.target, 180),
    glossaryEntryId: String(glossaryEntry?.id || ''),
    expanded: current?.expanded || '',
    abbreviation: current?.abbreviation || '',
    evidence: current?.evidence || null,
    definitions: definitions.slice(0, 6),
    ambiguous: definitions.length > 1,
  }
}

/**
 * 术语查词提示词；只要求解释当前语境，不扩写成长篇教学。
 * @param {{term: string, sentence: string, paragraph: string, section?: string, paperTitle?: string, local?: object}} options - 材料。
 * @returns {{system: string, user: string, maxTokens: number}} 提示词。
 */
export function buildTermLookupPrompt({
  term,
  sentence,
  paragraph,
  section = '',
  paperTitle = '',
  local = null,
}) {
  const system = [
    '你是论文正文里的即时术语解释器。只输出 JSON，不要 Markdown。',
    '目标是说明选中的词或短语在当前句子、当前论文语境中是什么意思，不翻译整段，不做英语学习建议。',
    '论文内缩写定义和术语表是优先依据；不得编造缩写全称、基因名、方法名或实验事实。',
    '无法可靠判断时，confidence 用 low 或 unknown，contextMeaning 写「未能可靠确定」，不要猜。',
    'generalMeaning 只能作为简短的模型常识补充；它不等于本文定义。',
    '输出字段：{"kind":"word|phrase|acronym|identifier|symbol|unknown",',
    '"expanded":"缩写全称，没有就空字符串","contextMeaning":"中文语境解释",',
    '"generalMeaning":"可选的简短普通含义","roleInSentence":"在句中的语法/论证作用",',
    '"confidence":"high|medium|low|unknown","warnings":["必要提示"]}',
  ].join('\n')
  const lines = [
    '论文：' + clip(paperTitle || '未命名论文', 180),
    section ? '章节：' + clip(section, 100) : '',
    '选中词：' + clip(term, MAX_TERM_CHARS),
    '当前句：' + clip(sentence, 620),
    '当前段：' + clip(paragraph, 1600),
  ].filter(Boolean)
  if (local?.expanded) lines.push('论文内缩写定义：' + local.expanded)
  if (Array.isArray(local?.definitions) && local.definitions.length > 1) {
    lines.push('论文内其他候选定义：' + local.definitions.slice(1, 6).map((item) => item.expanded).join(' / '))
  }
  if (local?.glossaryTarget) lines.push('当前术语表译名：' + local.glossaryTarget)
  if (local?.evidence?.quote) lines.push('定义原文：' + local.evidence.quote)
  return { system, user: lines.join('\n'), maxTokens: 700 }
}

function normalizeConfidence(value) {
  const text = clean(value).toLowerCase()
  if (CONFIDENCE.has(text)) return text
  if (/高|确定|high/.test(text)) return 'high'
  if (/中|medium/.test(text)) return 'medium'
  if (/低|不确定|low/.test(text)) return 'low'
  return 'unknown'
}

/**
 * 校验模型术语解释；术语表命中时可以直接用确定性结果。
 * @param {unknown} raw - 模型 JSON。
 * @param {{term: string, sentence: string, locator: object, local: object, source?: string}} options - 校验上下文。
 * @returns {object} 可渲染的查词结果。
 */
export function normalizeTermLookup(raw, { term, sentence, locator, local, source = 'model-context' }) {
  const glossaryTarget = clip(local?.glossaryTarget, 180)
  const modelMeaning = clip(raw?.contextMeaning, 360)
  const contextMeaning =
    glossaryTarget ||
    (modelMeaning && !/^未能可靠确定/.test(modelMeaning)
      ? modelMeaning
      : local?.expanded
        ? '论文中给出了全称，但没有可靠的中文语境解释。'
        : '未能可靠确定这个词在当前语境中的含义。')
  const rawKind = clean(raw?.kind).toLowerCase()
  const kindCandidate = TERM_KINDS.has(rawKind) ? rawKind : local?.kind
  const kind = TERM_KINDS.has(kindCandidate) ? kindCandidate : 'unknown'
  const warnings = []
  if (local?.glossaryTarget) warnings.push('中文解释来自当前论文术语表')
  else if (contextMeaning.startsWith('未能可靠确定')) warnings.push('当前材料不足，未强行猜测')
  if (local?.ambiguous && Array.isArray(local.definitions) && local.definitions.length > 1) {
    warnings.push('论文内发现 ' + local.definitions.length + ' 个可能的全称，已优先显示当前段候选，请结合上下文核对')
  }
  if (Array.isArray(raw?.warnings)) {
    for (const warning of raw.warnings.slice(0, 4)) {
      const text = clip(warning, 180)
      if (text && !warnings.includes(text)) warnings.push(text)
    }
  }
  return {
    term,
    kind,
    expanded: clip(local?.expanded || raw?.expanded, 180),
    abbreviation: clip(local?.abbreviation, 40),
    definitions: (Array.isArray(local?.definitions) ? local.definitions : [])
      .slice(0, 6)
      .map((item) => ({
        expanded: clip(item.expanded, 180),
        abbreviation: clip(item.abbreviation, 40),
        evidence: item.evidence || null,
      })),
    contextMeaning,
    generalMeaning: clip(raw?.generalMeaning, 220),
    roleInSentence: clip(raw?.roleInSentence, 260),
    confidence: glossaryTarget ? 'high' : normalizeConfidence(raw?.confidence),
    warnings,
    sentence: clip(sentence, 620),
    locator,
    evidence: local?.evidence || null,
    source: glossaryTarget ? 'paper-glossary' : source,
  }
}

/** 进程内缓存键；不落盘，也不形成用户词库。 */
export function termLookupKey({ jobId, blockId, term, sentence, version = '', glossaryTarget = '' }) {
  return createHash('sha256')
    .update(
      [
        'term=' + TERM_PROMPT_VERSION,
        'job=' + clean(jobId),
        'block=' + clean(blockId),
        'term=' + clean(term),
        'sentence=' + clean(sentence),
        'version=' + clean(version),
        'glossary=' + clean(glossaryTarget),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 24)
}
