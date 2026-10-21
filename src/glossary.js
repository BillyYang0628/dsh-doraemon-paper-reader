// 论文术语表：自动候选 + 用户覆盖 + 翻译缓存版本。

import { createHash } from 'node:crypto'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'were',
  'was', 'are', 'has', 'have', 'had', 'not', 'but', 'into', 'than', 'then',
  'their', 'there', 'which', 'while', 'using', 'used', 'can', 'may', 'also',
  'such', 'between', 'among', 'within', 'after', 'before', 'under', 'over',
])

const ACRONYM_RE = /\b[A-Z][A-Z0-9-]{1,9}\b/g
const EXPANSION_RE =
  /([A-Z][A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){1,7})\s*\(([A-Z][A-Z0-9-]{1,10})\)/g
const SECTION_WORDS = new Set([
  'INTRODUCTION',
  'RESULTS',
  'DISCUSSION',
  'MATERIALS',
  'METHODS',
  'REFERENCES',
  'SUPPORTING',
  'INFORMATION',
  'ACKNOWLEDGMENTS',
  'CONTRIBUTIONS',
  'AUTHOR',
  'AUTHORS',
  'ME',
  'THE',
  'US',
  'UK',
  'EU',
  'USA',
  'UN',
])

function usableAcronym(value) {
  const text = String(value || '')
  return (
    text.length >= 2 &&
    text.length <= 10 &&
    !text.endsWith('-') &&
    /[A-Z]{2}/.test(text) &&
    !SECTION_WORDS.has(text)
  )
}

function clean(value, limit = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function addEntry(map, source, patch = {}) {
  const key = source.toLowerCase()
  const current = map.get(key)
  if (current) {
    current.count += 1
    if (patch.expanded) current.expanded = true
    if (!current.target && patch.target) current.target = patch.target
    if (patch.kind === 'term' && current.kind === 'acronym') current.kind = 'term'
    return current
  }
  const entry = {
    source,
    target: patch.target || '',
    locked: Boolean(patch.locked),
    expanded: Boolean(patch.expanded),
    kind: patch.kind || 'term',
    count: 1,
    firstBlockId: patch.firstBlockId || '',
  }
  map.set(key, entry)
  return entry
}

/**
 * 从 MirrorDoc 抽取术语候选。自动项只是候选，用户可以改/删/锁定。
 * 不调用模型，避免为了术语表再产生一轮费用。
 */
export function extractGlossary(doc) {
  const map = new Map()
  const blocks = (doc?.blocks || []).filter(
    (block) =>
      ['heading', 'paragraph', 'caption'].includes(block?.type) &&
      !(Array.isArray(block?.qualityWarning) && block.qualityWarning.length),
  )
  for (const block of blocks) {
    const text = clean(block.text || block.caption || '', 20000)
    if (!text) continue
    for (const match of text.matchAll(EXPANSION_RE)) {
      const full = clean(match[1], 120)
      const acronym = clean(match[2], 20)
      if (full.split(/\s+/).length >= 2 && !STOPWORDS.has(full.split(/\s+/)[0].toLowerCase())) {
        addEntry(map, full, { kind: 'term', firstBlockId: block.id })
      }
      addEntry(map, acronym, { kind: 'acronym', expanded: true, firstBlockId: block.id })
    }
    for (const match of text.matchAll(ACRONYM_RE)) {
      const acronym = clean(match[0], 20)
      if (!usableAcronym(acronym) || STOPWORDS.has(acronym.toLowerCase())) continue
      addEntry(map, acronym, { kind: 'acronym', firstBlockId: block.id })
    }
  }

  // 重复出现的 2–4 词技术短语，只作为用户可编辑候选，不直接锁定。
  for (const block of blocks) {
    const text = clean(block.text || '', 20000)
    const words = text.match(/[A-Za-z][A-Za-z0-9-]*/g) || []
    for (let size = 2; size <= 2; size += 1) {
      for (let index = 0; index + size <= words.length; index += 1) {
        const phrase = words.slice(index, index + size)
        if (phrase.some((word) => STOPWORDS.has(word.toLowerCase()))) continue
        if (SECTION_WORDS.has(phrase.join(' ').toUpperCase())) continue
        if (/found at|doi|journal|table|figure|supplement|reference/i.test(phrase.join(' '))) continue
        if (!/^[A-Z]/.test(phrase[0])) continue
        addEntry(map, phrase.join(' '), { kind: 'term', firstBlockId: block.id })
      }
    }
  }

  return [...map.values()]
    .filter((entry) =>
      entry.kind === 'acronym' ? entry.expanded || entry.count >= 2 : entry.count >= 3,
    )
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, 80)
    .map((entry, index) => ({ ...entry, id: 'g' + index }))
}

/** 规范化用户保存的术语表，拒绝空项和超长内容。 */
export function normalizeGlossary(entries) {
  if (!Array.isArray(entries)) throw new Error('glossary entries must be an array')
  const seen = new Set()
  const out = []
  for (const [index, value] of entries.entries()) {
    if (!value || typeof value !== 'object') continue
    const source = clean(value.source, 160)
    const target = clean(value.target, 160)
    if (!source) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: String(value.id || 'g' + index),
      source,
      target,
      locked: Boolean(value.locked),
      kind: value.kind === 'acronym' ? 'acronym' : 'term',
      count: Math.max(1, Number(value.count) || 1),
      firstBlockId: clean(value.firstBlockId || '', 80),
    })
    if (out.length >= 300) break
  }
  return out
}

export function glossaryHash(entries = []) {
  const normalized = normalizeGlossary(entries)
    .map((entry) => ({ source: entry.source, target: entry.target, locked: entry.locked }))
    .sort((a, b) => a.source.localeCompare(b.source))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 20)
}

/** 只把已确定译名/锁定的条目送进翻译提示词。 */
export function promptGlossary(entries = []) {
  return normalizeGlossary(entries)
    .filter((entry) => entry.target || entry.locked)
    .map((entry) => ({
      src: entry.source,
      dst: entry.target || entry.source,
      locked: entry.locked,
    }))
}
