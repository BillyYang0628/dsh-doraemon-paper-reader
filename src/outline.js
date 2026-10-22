// B7 语义目录：确定性输入、模型输出校验、失败回退与语言展示。
//
// 目录不是论文主文的一部分。模型只能生成中文标签与短概括，原始标题、
// blockId、页码和顺序由 MirrorDoc 校验，模型无权改写。

import { createHash } from 'node:crypto'

export const OUTLINE_VERSION = 1
export const OUTLINE_CACHE_FILE = 'semantic-outline.v1.json'
export const OUTLINE_SOURCE_CHAR_LIMIT = 16000

const EXCLUDED_HEADING = /^(?:references?|bibliography|acknowledg|author contributions|funding|conflicts? of interest|supporting information|supplementary)\b/i
const SPECIAL_TITLE = /(?:table|figure|algorithm|equation)\s*\d+/i

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function clip(value, limit) {
  const text = clean(value)
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

function headingLevel(block) {
  const value = Number(block?.level)
  return value >= 1 && value <= 3 ? value : 1
}

function allowedHeading(block) {
  const title = clean(block?.text)
  if (!block?.id || block?.type !== 'heading' || !title) return false
  if (EXCLUDED_HEADING.test(title)) return false
  if (SPECIAL_TITLE.test(title)) return false
  return true
}

function sectionGists(doc) {
  const result = new Map()
  for (const section of doc?.meta?.brief?.sections || []) {
    const title = clean(section?.heading);
    if (!title) continue
    result.set(title.toLowerCase(), clip(section?.gist, 180))
  }
  return result
}

function nearbyExcerpt(blocks, index) {
  for (const block of blocks.slice(index + 1, index + 5)) {
    if (block?.type !== 'paragraph') continue
    const text = clean(block.text)
    if (text.length >= 50) return clip(text, 260)
  }
  return ''
}

/**
 * 构造模型可读、完整覆盖 heading 的压缩目录输入。
 */
export function buildOutlineSource(doc = {}) {
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
  const gists = sectionGists(doc)
  const entries = []
  const abstract = clean(doc?.meta?.abstract || doc?.meta?.brief?.abstract)
  if (abstract) {
    entries.push({
      blockId: '__meta_abstract',
      page: 1,
      level: 1,
      originalTitle: 'Abstract',
      gist: clip(abstract, 220),
      excerpt: '',
    })
  }
  let used = abstract ? 120 : 0
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!allowedHeading(block)) continue
    const title = clean(block.text)
    const gist = gists.get(title.toLowerCase()) || ''
    const excerpt = nearbyExcerpt(blocks, index)
    const entry = {
      blockId: String(block.id),
      page: Number(block.page) || 0,
      level: headingLevel(block),
      originalTitle: title,
      gist: clip(gist, 180),
      excerpt,
    }
    const cost = title.length + entry.gist.length + entry.excerpt.length + 30
    if (entries.length > 0 && used + cost > OUTLINE_SOURCE_CHAR_LIMIT) {
      entry.excerpt = clip(entry.excerpt, 100)
    }
    entries.push(entry)
    used += cost
    if (used >= OUTLINE_SOURCE_CHAR_LIMIT) break
  }
  return {
    title: clean(doc?.meta?.title),
    abstract: clip(abstract, 1200),
    entries,
  }
}

/** 目录输入指纹；heading/gist 变化时旧缓存失效。 */
export function outlineSourceHash(source) {
  return createHash('sha256')
    .update(JSON.stringify(source))
    .digest('hex')
}

/** 生成模型提示词；模型只返回中文 label/summary。 */
export function buildSemanticOutlinePrompt(doc = {}) {
  const source = buildOutlineSource(doc)
  const lines = [
    '论文标题：' + source.title,
    source.abstract ? '摘要：' + source.abstract : '',
    '',
    '允许进入目录的锚点（不得新增、删除、改写 blockId）：',
    ...source.entries.map(
      (entry, index) =>
        '[' +
        (index + 1) +
        '] blockId=' +
        entry.blockId +
        ' | p.' +
        entry.page +
        ' | level=' +
        entry.level +
        ' | original=' +
        entry.originalTitle +
        (entry.gist ? ' | gist=' + entry.gist : '') +
        (entry.excerpt ? ' | excerpt=' + entry.excerpt : ''),
    ),
  ].filter(Boolean)
  return {
    source,
    system: [
      '你是论文语义目录编辑器。',
      '把给定 heading 归成 3–8 个一级语义组，并为每组和每个 heading 写短中文标签与概括。',
      '只允许使用输入中的 blockId；每个 blockId 恰好出现一次；不得改写原始顺序。',
      '禁止把表格行、算法步骤、图表题注、参考文献条目写进目录。',
      '如果某个标题本身不清晰，可写概括，但必须保留其定位 blockId。',
      '只输出 JSON：{"groups":[{"label":"研究背景","summary":"...","items":[{"blockId":"...","label":"...","summary":"..."}]}]}。',
    ].join('\n'),
    user: lines.join('\n'),
    maxTokens: 4200,
  }
}

function fallbackLabel(title) {
  const value = clean(title)
  if (/abstract|摘要/i.test(value)) return '摘要'
  if (/introduction|background|motivation/i.test(value)) return '研究背景'
  if (/related work|literature/i.test(value)) return '相关工作'
  if (/method|material|approach|architecture|model|design/i.test(value)) return '方法与设计'
  if (/experiment|evaluation|result|discussion/i.test(value)) return '实验与结果'
  if (/limitation|threat|risk/i.test(value)) return '局限与风险'
  if (/conclusion|future work/i.test(value)) return '结论与展望'
  return '其他章节'
}

function fallbackGroupId(label) {
  return (
    {
      摘要: 'abstract',
      研究背景: 'background',
      相关工作: 'related-work',
      方法与设计: 'method',
      实验与结果: 'results',
      局限与风险: 'limitations',
      结论与展望: 'conclusion',
      其他章节: 'other',
    }[label] || 'other'
  )
}

/**
 * 无模型或模型输出失败时的确定性两层目录。
 */
export function fallbackOutline(doc = {}) {
  const source = buildOutlineSource(doc)
  const groups = new Map()
  for (const entry of source.entries) {
    const label = fallbackLabel(entry.originalTitle)
    if (!groups.has(label)) {
      groups.set(label, {
        id: fallbackGroupId(label),
        label,
        summary: '',
        items: [],
      })
    }
    groups.get(label).items.push({
      blockId: entry.blockId,
      page: entry.page,
      level: entry.level,
      originalTitle: entry.originalTitle,
      label: entry.originalTitle,
      summary: entry.gist,
    })
  }
  return {
    version: OUTLINE_VERSION,
    semantic: false,
    fallbackReason: 'not-generated',
    sourceHash: outlineSourceHash(source),
    groups: [...groups.values()],
  }
}

/**
 * 校验并收敛模型目录。缺失的 heading 会补入“其他章节”，不能静默丢失导航。
 */
export function normalizeSemanticOutline(raw, doc = {}) {
  const source = buildOutlineSource(doc)
  const allowed = new Map(source.entries.map((entry) => [entry.blockId, entry]))
  const used = new Set()
  const groups = []
  const rawGroups = Array.isArray(raw?.groups) ? raw.groups : []
  for (const rawGroup of rawGroups.slice(0, 8)) {
    const items = []
    for (const rawItem of (Array.isArray(rawGroup?.items) ? rawGroup.items : []).slice(0, 30)) {
      const blockId = clean(rawItem?.blockId)
      const entry = allowed.get(blockId)
      if (!entry || used.has(blockId)) continue
      const label = clip(rawItem?.label, 60) || entry.originalTitle
      if (EXCLUDED_HEADING.test(label) || SPECIAL_TITLE.test(label)) continue
      used.add(blockId)
      items.push({
        blockId,
        page: entry.page,
        level: entry.level,
        originalTitle: entry.originalTitle,
        label,
        summary: clip(rawItem?.summary, 180),
      })
    }
    if (items.length === 0) continue
    const label = clip(rawGroup?.label, 42) || '其他章节'
    groups.push({
      id: 'outline-' + (groups.length + 1),
      label,
      summary: clip(rawGroup?.summary, 220),
      items,
    })
  }
  const missing = source.entries.filter((entry) => !used.has(entry.blockId))
  if (missing.length > 0) {
    let other = groups.find((group) => group.label === '其他章节')
    if (!other) {
      other = { id: 'outline-other', label: '其他章节', summary: '', items: [] }
      groups.push(other)
    }
    for (const entry of missing) {
      other.items.push({
        blockId: entry.blockId,
        page: entry.page,
        level: entry.level,
        originalTitle: entry.originalTitle,
        label: entry.originalTitle,
        summary: entry.gist,
      })
    }
  }
  const items = groups.flatMap((group) => group.items)
  if (items.length === 0) return null
  return {
    version: OUTLINE_VERSION,
    semantic: true,
    sourceHash: outlineSourceHash(source),
    groups,
    itemCount: items.length,
    sourceCount: source.entries.length,
    coverage: source.entries.length ? items.length / source.entries.length : 1,
  }
}

/**
 * 根据阅读语言模式生成展示字段。
 */
export function outlineDisplayGroups(outline, language = 'bilingual') {
  const groups = Array.isArray(outline?.groups) ? outline.groups : []
  return groups.map((group) => ({
    ...group,
    displayLabel:
      language === 'original'
        ? group.items?.[0]?.originalTitle || group.label
        : group.label,
    items: (group.items || []).map((item) => ({
      ...item,
      label:
        language === 'original'
          ? item.originalTitle || item.label
          : item.label || item.originalTitle,
      secondary:
        language === 'bilingual'
          ? item.originalTitle && item.originalTitle !== item.label
            ? item.originalTitle
            : ''
          : '',
    })),
  }))
}
