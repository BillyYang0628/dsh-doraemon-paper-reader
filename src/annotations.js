// 宿主半区：批注批次存储与模型读取工具。
//
// 为什么要多这一层：
//   - 浏览器里的「问大肥鱼」需要把原文、位置戳、页码、前后文和问题一起交给模型；
//   - 但这整包 JSON 直接塞进用户消息会把聊天气泡撑满，也不是给人读的；
//   - 所以完整包先落到 $DSH_HOME/doraemon-paper-reader/annotation-batches/<id>.json，
//     用户消息只保留「批注 1 / 批注 2」这类可读摘要 + 一个短批次号；
//   - 模型收到摘要后调用 doraemon_read_annotations 取回完整包，视觉与上下文两不误。

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildAnnotationContract,
  buildAnnotationToolPolicy,
  buildAnswerPolicy,
  normalizeAnswerPolicy,
} from './qa-contract.js'

/** 批注 API 的单批上限；正常论文批注远小于这个值。 */
export const MAX_ANNOTATION_BYTES = 512 * 1024
/** 批次号只允许我们生成的形状，防止把用户输入拼进文件路径。 */
export const BATCH_ID_RE = /^batch_[a-f0-9]{24}$/
/** 单批最多几条批注；防止误传超大批注把聊天上下文拖垮。 */
export const MAX_ANNOTATIONS = 20
/** 单条批注最多几段（跨段选区 / 图文混选）。 */
export const MAX_SEGMENTS = 30
/** 用户消息与工具卡片最多列几条；完整列表仍在批次里。 */
export const SUMMARY_LIMIT = 12
/** jobId 与 papers.js 的约定一致；只用于拼只读 assetPath。 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** 带 HTTP 状态码的错误，交给 papers.js 的 handler 统一回包。 */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

/** 把空白压成一行，并按字数截断；摘要只给人看，完整内容仍在批次里。 */
function excerpt(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

/** 一段选区所在页码；多段时给出 `p.3/4` 这种紧凑写法。 */
function pageLabel(segments) {
  const pages = [...new Set(segments.map((segment) => Number(segment?.page)).filter((page) => page > 0))]
  return pages.length === 0 ? '页码未知' : 'p.' + pages.join('/')
}

/** 一段选区的位置摘要；单段优先给章节，多段给段数。 */
function placeLabel(segments) {
  if (segments.length > 1) return segments.length + ' 段'
  const first = segments[0]
  if (first?.kind && first.kind !== 'text') {
    const kindLabel = { figure: '图', table: '表格', equation: '公式' }[first.kind] || first.kind
    return excerpt(first.label, 32) || kindLabel
  }
  const section = excerpt(first?.section, 32)
  return section || '正文'
}

/**
 * 给特殊块补一条宿主机可读的绝对 assetPath；模型需要看图时可自行调用 read_image，
 * 不把图片字节无条件塞进每次请求。
 * @param {object} packet - 已校验的批注包。
 * @param {string} dataRoot - $DSH_HOME/doraemon-paper-reader。
 */
function enrichAssetPaths(packet, dataRoot) {
  for (const annotation of packet.annotations) {
    const jobId = String(annotation.jobId || '')
    if (!JOB_ID_RE.test(jobId)) continue
    for (const segment of annotation.segments) {
      const blockId = String(segment.blockId || '')
      if (/^[A-Za-z0-9_-]{1,80}$/.test(blockId)) {
        segment.citationDeepLink = 'dsh-resource://doraemon-paper/' + jobId + '/' + blockId
      }
      const asset = String(segment.asset || '')
      if (
        !asset ||
        path.isAbsolute(asset) ||
        asset.includes('..') ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(asset)
      ) {
        continue
      }
      segment.assetPath = path.join(dataRoot, 'jobs', jobId, asset)
    }
  }
}

/**
 * 校验浏览器发来的批注包。只做结构与尺寸校验，不改写内容。
 * @param {unknown} packet - 待保存的批注包。
 * @returns {{type: string, question: string, annotations: object[]}} 通过校验的包。
 */
export function assertAnnotationPacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw httpError(400, '批注包必须是一个对象')
  }
  if (packet.type !== 'doraemon-annotations') {
    throw httpError(400, '批注包类型不对')
  }
  if (!Array.isArray(packet.annotations) || packet.annotations.length === 0) {
    throw httpError(400, '批注包至少要有 1 条批注')
  }
  if (packet.annotations.length > MAX_ANNOTATIONS) {
    throw httpError(400, '一次最多发送 ' + MAX_ANNOTATIONS + ' 条批注')
  }
  for (const [index, item] of packet.annotations.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw httpError(400, '第 ' + (index + 1) + ' 条批注格式不对')
    }
    if (typeof item.question !== 'string') {
      throw httpError(400, '第 ' + (index + 1) + ' 条批注的问题必须是文本')
    }
    if (!Array.isArray(item.segments) || item.segments.length === 0) {
      throw httpError(400, '第 ' + (index + 1) + ' 条批注没有原文片段')
    }
    if (item.segments.length > MAX_SEGMENTS) {
      throw httpError(400, '第 ' + (index + 1) + ' 条批注的段数太多')
    }
    for (const segment of item.segments) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        throw httpError(400, '第 ' + (index + 1) + ' 条批注的原文片段格式不对')
      }
      if (typeof segment.quote !== 'string' || segment.quote.trim() === '') {
        throw httpError(400, '第 ' + (index + 1) + ' 条批注的原文片段是空的')
      }
    }
  }
  packet.answerPolicy = normalizeAnswerPolicy(packet.answerPolicy)
  return packet
}

/**
 * 生成用户消息里那段「可读摘要」。
 * 注意：这里绝不拼完整 JSON；完整包由 doraemon_read_annotations 按批次号取。
 * @param {object} packet - 已通过校验的批注包。
 * @param {string} batchId - 宿主生成的批次号。
 * @returns {string} 适合直接作为用户消息发送的 Markdown 文本。
 */
export function buildAnnotationMessage(packet, batchId) {
  const annotations = packet.annotations
  const lines = []
  const paperTitles = [
    ...new Set(
      annotations
        .map((item) => excerpt(item?.context?.paper?.title, 64))
        .filter(Boolean),
    ),
  ]
  const multiPaper = paperTitles.length > 1
  const paper = paperTitles[0] || ''
  if (multiPaper) {
    lines.push('🧭 跨 ' + paperTitles.length + ' 篇论文的 ' + annotations.length + ' 条批注')
    lines.push('论文：' + paperTitles.map((title) => '《' + title + '》').join('、'))
  } else {
    if (paper) lines.push('《' + paper + '》')
    lines.push('📝 ' + annotations.length + ' 条批注')
  }
  for (const [index, item] of annotations.slice(0, SUMMARY_LIMIT).entries()) {
    const segments = Array.isArray(item.segments) ? item.segments : []
    const note = excerpt(item.question, 48)
    const itemPaper = excerpt(item?.context?.paper?.title, 40)
    lines.push(
      '・🗒️ 批注 ' +
        (index + 1) +
        ' · ' +
        (multiPaper && itemPaper ? '《' + itemPaper + '》 · ' : '') +
        pageLabel(segments) +
        ' · ' +
        placeLabel(segments) +
        (note ? ' — 「' + note + '」' : ' — （只标记，未写问题）'),
    )
    const linked = segments.find((segment) => segment.citationDeepLink)
    const returnLink = linked?.citationUrl || linked?.citationDeepLink
    if (linked && returnLink) {
      lines.push(
        '  ↳ 回跳：' +
          '[p.' +
          (Number(linked.page) || '?') +
          '](' +
          returnLink +
          ')',
      )
    }
  }
  if (annotations.length > SUMMARY_LIMIT) {
    lines.push('・…另有 ' + (annotations.length - SUMMARY_LIMIT) + ' 条批注，完整列表在批次中。')
  }
  const shared = excerpt(packet.question, 200)
  if (shared) lines.push('', '整体问题：' + shared)
  lines.push('', buildAnnotationContract(packet, { compact: true }))
  const rules = [
    '请先调用 doraemon_read_annotations 读取该批次的完整原文、前后文与各条问题，再作答；涉及原文时保留页码与段落定位。',
    ...(multiPaper
      ? ['这是跨论文批次：先按论文分别理解，再回答整体问题；引用原文时标明论文名与 blockId，不要把一篇的结论安到另一篇上。']
      : []),
    '工具返回的 qaContract / answerPolicy 是本次回答的具体策略；若与通用习惯冲突，以它们为准。',
    '回答里若要引用原文，请直接复制上面的「回跳」Markdown 链接，或在工具结果中使用 segments[].citationDeepLink；不要改写成文件路径。回答末尾至少附一条对应原段的回跳链接。',
  ]
  lines.push('', '批次：' + batchId, ...rules)
  return lines.join('\n')
}

/**
 * 给工具结果卡片用的紧凑摘要（不是给模型看的正文）。
 * @param {object} packet - 工具返回的批注包。
 * @returns {{count: number, paper: string, lines: string[]}} 可持久化的展示元数据。
 */
export function summarizeAnnotationPacket(packet) {
  const annotations = Array.isArray(packet?.annotations) ? packet.annotations : []
  const paperTitles = [
    ...new Set(
      annotations
        .map((item) => excerpt(item?.context?.paper?.title, 80))
        .filter(Boolean),
    ),
  ]
  const lines = annotations.slice(0, SUMMARY_LIMIT).map((item, index) => {
    const segments = Array.isArray(item.segments) ? item.segments : []
    const note = excerpt(item.question, 64)
    const itemPaper = excerpt(item?.context?.paper?.title, 40)
    return (
      '批注 ' +
      (index + 1) +
      ' · ' +
      (paperTitles.length > 1 && itemPaper ? '《' + itemPaper + '》 · ' : '') +
      pageLabel(segments) +
      ' · ' +
      placeLabel(segments) +
      (note ? ' — 「' + note + '」' : ' — （只标记）')
    )
  })
  if (annotations.length > SUMMARY_LIMIT) {
    lines.push('…另有 ' + (annotations.length - SUMMARY_LIMIT) + ' 条批注，完整列表在批次中。')
  }
  return {
    count: annotations.length,
    paper: paperTitles.length > 1 ? paperTitles.length + ' 篇论文' : paperTitles[0] || '',
    papers: paperTitles,
    lines,
  }
}

/**
 * 创建批注批次仓库。数据落在 $DSH_HOME/doraemon-paper-reader/annotation-batches/。
 * @param {object} options - 配置。
 * @param {string} options.dataRoot - 数据根目录。
 * @returns {{save: Function, read: Function, dir: string}} 批次仓库。
 */
export function createAnnotationBatchStore({ dataRoot }) {
  const dir = path.join(dataRoot, 'annotation-batches')

  return {
    dir,
    /**
     * 保存一批批注，返回短批次号与可读摘要。
     * @param {unknown} rawPacket - 浏览器发来的 JSON。
     * @returns {Promise<{batchId: string, count: number, message: string}>} 保存结果。
     */
    async save(rawPacket) {
      const packet = assertAnnotationPacket(rawPacket)
      enrichAssetPaths(packet, dataRoot)
      let serialized
      try {
        serialized = JSON.stringify(packet)
      } catch (cause) {
        throw httpError(400, '批注包无法序列化：' + (cause?.message || String(cause)))
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_ANNOTATION_BYTES) {
        throw httpError(413, '批注包超过 512 KB 上限')
      }
      await mkdir(dir, { recursive: true })
      const batchId = 'batch_' + randomBytes(12).toString('hex')
      const record = {
        protocol: 1,
        batchId,
        createdAt: new Date().toISOString(),
        packet,
      }
      await writeFile(path.join(dir, batchId + '.json'), JSON.stringify(record, null, 2), 'utf8')
      return {
        batchId,
        count: packet.annotations.length,
        message: buildAnnotationMessage(packet, batchId),
      }
    },
    /**
     * 按批次号读取完整包。
     * @param {string} batchId - `batch_` + 24 位小写十六进制。
     * @returns {Promise<{protocol: number, batchId: string, createdAt: string, packet: object}>} 记录。
     */
    async read(batchId) {
      const id = String(batchId ?? '')
      if (!BATCH_ID_RE.test(id)) throw httpError(400, '批注批次号不合法')
      let raw
      try {
        raw = await readFile(path.join(dir, id + '.json'), 'utf8')
      } catch (cause) {
        if (cause?.code === 'ENOENT') {
          throw httpError(404, '这批批注已经找不到了，陛下请在阅读页重新发送一次。')
        }
        throw cause
      }
      let record
      try {
        record = JSON.parse(raw)
      } catch {
        throw httpError(500, '批注批次文件损坏了')
      }
      if (record?.batchId !== id || record?.protocol !== 1 || !record?.packet) {
        throw httpError(500, '批注批次文件内容不对')
      }
      return record
    },
  }
}

/**
 * 创建模型工具 `doraemon_read_annotations`。
 * 模型看到的是完整 JSON；聊天里的工具卡片只显示紧凑摘要。
 * @param {object} options - 配置。
 * @param {{read: Function}} options.store - 批注批次仓库。
 * @returns {object} 可直接交给 ctx.tools.register 的工具定义。
 */
export function createReadAnnotationsTool({ store }) {
  return {
    name: 'doraemon_read_annotations',
    description:
      '读取大肥鱼论文阅读器暂存的批注批次。用户消息里出现“批次：`batch_...`”时，先调用本工具取得完整原文、前后文、页码、章节、图表公式与每条批注问题，再作答。若 annotations[].segments[] 带 assetPath（Figure/Table/Equation 的裁剪图），需要看图时对 assetPath 调用 read_image。回答里引用原文时，优先使用 segments[].citationUrl（HTTP 回跳页）作为 Markdown 链接地址；没有 citationUrl 时再用 citationDeepLink。不要改写成文件路径。\n' +
      buildAnnotationToolPolicy(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['batchId'],
      properties: {
        batchId: {
          type: 'string',
          description: '用户消息里的批注批次号，形如 batch_0123456789abcdef01234567。',
        },
      },
    },
    output: {
      // 原始注册接口只接受受支持的 JSON Schema；对象根 + 开放属性 = 任意 JSON 包。
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => summarizeAnnotationPacket(value),
    },
    async execute(args) {
      const batchId = String(args?.batchId ?? '')
      const record = await store.read(batchId)
      return {
        ...record.packet,
        batchId: record.batchId,
        createdAt: record.createdAt,
        answerPolicy: buildAnswerPolicy(record.packet),
        qaContract: buildAnnotationContract(record.packet),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取大肥鱼批注',
      kind: 'read',
      rawInput: '批次 ' + String(args?.batchId ?? ''),
    }),
    presentResult: (_args, result) => {
      const meta = result?.meta
      const lines = Array.isArray(meta?.lines) ? meta.lines : []
      const title = '已读取 ' + (Number(meta?.count) || 0) + ' 条批注'
      return {
        card: 'generic',
        title,
        content: lines.length > 0 ? [{ type: 'text', text: lines.join('\n') }] : undefined,
      }
    },
    isConcurrencySafe: () => true,
  }
}
