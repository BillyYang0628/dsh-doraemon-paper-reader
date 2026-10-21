// 宿主半区：多篇对照用的「论文精简档案」。
//
// 为什么要有这一层：
//   - 主对话要同时理解 2–3 篇论文，但不能把整篇 MirrorDoc 重传（Responses API 无状态，
//     每轮都重传历史；一篇论文几十 KB 会把对照场景拖垮）；
//   - 所以这里把 MirrorDoc 压成确定性的结构：元数据 + 摘要 + 章节 + 每节关键段 + blockId。
//     模型拿到的是「能定位的最少材料」，不是全文，也不是重新生成的摘要；
//   - 章节与关键段都保留 blockId，回答里的每条结论才能回到原段核对（AGENTS.md §2.1）。
//
// 本模块只做确定性抽取，不调模型。真正的比较提示词在 src/compare.js。

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 档案结构版本；字段变化时递增，缓存与提示词一起失效。 */
export const DIGEST_VERSION = 2
/** 一次最多对照几篇；与界面多选上限一致。 */
export const MAX_DIGEST_PAPERS = 3
/** 单篇档案的字符预算；超了就按「关键段 → 章节」顺序裁。 */
export const DIGEST_CHAR_LIMIT = 4800
/** jobId 形状与 papers.js 一致。 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/** 压掉空白，避免 PDF/HTML 抽取的换行把档案撑大。 */
function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 按字符截断，保留一个省略号。 */
function clip(value, limit) {
  const text = clean(value)
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

/** 标题归一化：去掉编号、标点与大小写差异，用于 brief.heading → blockId。 */
function headingKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^[\d.\s]+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 把文档里的标题块按归一化标题建索引；同一标题只留第一个。 */
function buildHeadingIndex(doc) {
  const index = new Map()
  for (const block of Array.isArray(doc?.blocks) ? doc.blocks : []) {
    if (block?.type !== 'heading' || !block.text) continue
    const key = headingKey(block.text)
    if (key && !index.has(key)) index.set(key, block)
  }
  return index
}

/** 取论文年份：优先 meta.year，其次 generatedAt，最后 DOI/arXiv 里的四位年。 */
function paperYear(doc) {
  const direct = Number(doc?.meta?.year)
  if (direct > 1800) return direct
  // 不拿 generatedAt 当出版年：那是导入时间，会把 2026 写成论文年份。
  const arxiv = String(doc?.meta?.arxivId || '')
  const match = arxiv.match(/^(\d{2})(\d{2})\./)
  if (match) {
    const year = Number('20' + match[1])
    if (year >= 1991 && year <= 2100) return year
  }
  return 0
}

/** 数一类块；brief 里已有计数时优先用 brief 的。 */
function blockCount(doc, type) {
  return (Array.isArray(doc?.blocks) ? doc.blocks : []).filter((block) => block?.type === type).length
}

/** 一节是否值得多给一段（结论/讨论/局限通常是对照最需要的）。 */
function isPrioritySection(title) {
  return /conclusion|discussion|limitation|结论|讨论|局限/i.test(String(title || ''))
}

/**
 * 从 MirrorDoc + summary 生成一篇论文的精简档案。
 * @param {{jobId: string, doc: object, summary?: object, maxChars?: number}} options - 输入。
 * @returns {object} 可比对、可定位的档案。
 */
export function buildPaperDigest({ jobId, doc, summary = null, maxChars = DIGEST_CHAR_LIMIT }) {
  const meta = doc?.meta || {}
  const brief = meta.brief || {}
  const headingIndex = buildHeadingIndex(doc)
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : []

  const sections = []
  for (const section of Array.isArray(brief.sections) ? brief.sections : []) {
    const title = clean(section?.heading)
    if (!title) continue
    // 参考文献/致谢/补充材料不是可比较的论证章节，别占对照表的章节位。
    if (/^(references?|bibliography|acknowledg|supporting information|supplementary|appendix)/i.test(title)) {
      continue
    }
    const headingBlock = headingIndex.get(headingKey(title))
    sections.push({
      title: clip(title, 90),
      page: Number(section?.page) || Number(headingBlock?.page) || 0,
      blockId: String(headingBlock?.id || ''),
      gist: clip(section?.gist, 150),
    })
    if (sections.length >= 8) break
  }

  // brief 缺失时退回块级章节；PDF 老作业没有 brief 也能对照。
  if (sections.length === 0) {
    for (const block of blocks) {
      if (block?.type !== 'heading') continue
      sections.push({
        title: clip(block.text, 90),
        page: Number(block.page) || 0,
        blockId: String(block.id || ''),
        gist: '',
      })
      if (sections.length >= 8) break
    }
  }

  const excerpts = []
  const used = new Set()
  const addExcerpt = (block, sectionTitle) => {
    if (!block || used.has(block.id)) return
    const text = clip(block.text, 240)
    if (text.length < 60) return
    used.add(block.id)
    excerpts.push({
      blockId: String(block.id || ''),
      page: Number(block.page) || 0,
      section: clip(sectionTitle || block.section, 80),
      text,
    })
  }
  const prose = blocks.filter((block) => block?.type === 'paragraph' || block?.type === 'text')
  for (const section of sections) {
    const key = headingKey(section.title)
    const inSection = prose.filter((block) => headingKey(block.section).startsWith(key) || key === '')
    const picked = inSection[0] || prose.find((block) => !used.has(block.id))
    addExcerpt(picked, section.title)
    if (isPrioritySection(section.title)) addExcerpt(inSection[1], section.title)
    if (excerpts.length >= 10) break
  }
  if (excerpts.length === 0) {
    for (const block of prose) {
      addExcerpt(block, block.section)
      if (excerpts.length >= 3) break
    }
  }

  const digest = {
    version: DIGEST_VERSION,
    jobId: String(jobId),
    title: clip(meta.title || summary?.title, 180) || '未命名论文',
    authors: clip(meta.authors || summary?.authors, 120),
    versionInfo: {
      kind: clip(doc?.version?.kind || summary?.version?.kind || 'unknown', 24),
      label: clip(
        doc?.version?.label ||
          summary?.version?.label ||
          (doc?.version?.kind || summary?.version?.kind ? '' : '版本未核验'),
        80,
      ),
      source: clip(doc?.version?.source || summary?.version?.source, 120),
    },
    year: paperYear(doc) || Number(summary?.year) || 0,
    doi: clean(meta.doi || summary?.identifiers?.doi),
    arxiv: clean(meta.arxivId || summary?.identifiers?.arxiv),
    license: clip(meta.license, 60),
    abstract: clip(meta.abstract || brief.abstract || summary?.abstract, 620),
    sections,
    excerpts,
    counts: {
      blocks: blocks.length,
      figures: Array.isArray(brief.figures) ? brief.figures.length : blockCount(doc, 'figure'),
      tables: Array.isArray(brief.tables) ? brief.tables.length : blockCount(doc, 'table'),
      equations: Array.isArray(brief.equations) ? brief.equations.length : blockCount(doc, 'equation'),
      references:
        Number(brief.referenceCount) ||
        (Array.isArray(brief.references) ? brief.references.length : blockCount(doc, 'reference')),
    },
  }

  // 字符预算：先砍关键段，再砍靠后的章节；摘要与标题永远保留。
  while (JSON.stringify(digest).length > maxChars && digest.excerpts.length > 0) {
    digest.excerpts.pop()
  }
  while (JSON.stringify(digest).length > maxChars && digest.sections.length > 1) {
    digest.sections.pop()
  }
  digest.charCount = JSON.stringify(digest).length
  return digest
}

/**
 * 把档案压成给模型看的紧凑文本（比 JSON 少一些引号与字段名）。
 * @param {object} digest - buildPaperDigest 的结果。
 * @param {string} [tag] - 论文编号，如 P1。
 * @returns {string} 可直接拼进提示词的文本。
 */
export function digestToText(digest, tag = '') {
  const lines = []
  const head = [
    tag ? '[' + tag + ']' : '',
    '《' + digest.title + '》',
    digest.year ? String(digest.year) : '',
    digest.doi ? 'DOI ' + digest.doi : '',
    digest.arxiv ? 'arXiv ' + digest.arxiv : '',
    digest.versionInfo?.label || digest.versionInfo?.kind || '版本未核验',
    'jobId=' + digest.jobId,
  ].filter(Boolean)
  lines.push(head.join(' · '))
  if (digest.abstract) lines.push('摘要：' + digest.abstract)
  if (digest.sections.length > 0) {
    lines.push('章节：')
    for (const section of digest.sections) {
      const anchor = section.blockId ? ' [' + section.blockId + (section.page ? ' p.' + section.page : '') + ']' : ''
      lines.push('- ' + section.title + anchor + (section.gist ? ' — ' + section.gist : ''))
    }
  }
  if (digest.excerpts.length > 0) {
    lines.push('关键段：')
    for (const excerpt of digest.excerpts) {
      lines.push(
        '- [' + excerpt.blockId + (excerpt.page ? ' p.' + excerpt.page : '') + ']' +
          (excerpt.section ? ' ' + excerpt.section + '：' : ' ') +
          excerpt.text,
      )
    }
  }
  lines.push(
    '规模：图 ' +
      digest.counts.figures +
      ' · 表 ' +
      digest.counts.tables +
      ' · 公式 ' +
      digest.counts.equations +
      ' · 参考文献 ' +
      digest.counts.references,
  )
  return lines.join('\n')
}

/**
 * 生成一个受 job 目录约束的读取器：digest 与单块原文都只走 jobsRoot 下的作业。
 * @param {{jobsRoot: string}} options - 作业根目录。
 * @returns {{readDigests: Function, readBlock: Function}} 读取器。
 */
export function createPaperDigestReader({ jobsRoot }) {
  const jobDir = (jobId) => {
    const id = String(jobId || '')
    if (!JOB_ID_RE.test(id)) {
      throw Object.assign(new Error('作业 id 形状不对'), { statusCode: 400 })
    }
    return path.join(jobsRoot, id)
  }

  const readDoc = async (jobId) => {
    const dir = jobDir(jobId)
    let text
    try {
      text = await readFile(path.join(dir, 'mirrordoc.json'), 'utf8')
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw Object.assign(new Error('这篇论文的作业目录不在了：' + String(jobId)), { statusCode: 404 })
      }
      throw cause
    }
    return JSON.parse(text)
  }

  return {
    /**
     * 读取 1–3 篇论文的档案；顺序与输入一致，重复 id 只读一次。
     * @param {string[]} jobIds - 作业 id 列表。
     * @returns {Promise<object[]>} 档案列表。
     */
    async readDigests(jobIds) {
      const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((id) => String(id || '')).filter(Boolean))]
      if (ids.length === 0) {
        throw Object.assign(new Error('至少要给 1 篇论文'), { statusCode: 400 })
      }
      if (ids.length > MAX_DIGEST_PAPERS) {
        throw Object.assign(new Error('一次最多对照 ' + MAX_DIGEST_PAPERS + ' 篇论文'), { statusCode: 400 })
      }
      const digests = []
      for (const id of ids) {
        const doc = await readDoc(id)
        let summary = null
        try {
          summary = JSON.parse(await readFile(path.join(jobsRoot, id, 'paper-summary.json'), 'utf8'))
        } catch {
          // summary 只是补充；没有也能从 MirrorDoc 取。
        }
        digests.push(buildPaperDigest({ jobId: id, doc, summary }))
      }
      return digests
    },

    /**
     * 读取某个 block 的原文；引用对照里必须由宿主取，不能信浏览器传的 quote。
     * @param {string} jobId - 作业 id。
     * @param {string} blockId - 块 id。
     * @returns {Promise<object>} 块信息。
     */
    async readBlock(jobId, blockId) {
      const id = String(blockId || '')
      if (!BLOCK_ID_RE.test(id)) {
        throw Object.assign(new Error('块 id 形状不对'), { statusCode: 400 })
      }
      const doc = await readDoc(jobId)
      const block = (Array.isArray(doc?.blocks) ? doc.blocks : []).find((item) => item?.id === id)
      if (!block) {
        throw Object.assign(new Error('没有找到这个段落：' + id), { statusCode: 404 })
      }
      return {
        jobId: String(jobId),
        blockId: id,
        type: block.type || 'text',
        page: Number(block.page) || 0,
        section: clip(block.section, 100),
        text: clip(block.text || block.caption, 1200),
      }
    },
  }
}
