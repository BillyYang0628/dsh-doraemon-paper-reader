// 图像资产的纯逻辑：公式 LaTeX 转写、表格译文校验与缓存键。

import { createHash } from 'node:crypto'

export const FORMULA_PROMPT_VERSION = 1
export const TABLE_PROMPT_VERSION = 1

function cleanCell(value, limit = 240) {
  return String(value ?? '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function formulaPrompt(block) {
  return [
    '把这张学术论文里的公式裁剪图转写成单行 LaTeX。',
    '标签：' + String(block?.label || 'Equation'),
    '页码：' + String(block?.page || ''),
    '要求：',
    '1. 只转写图中实际可见的公式，不要补上下文、不要解释。',
    '2. 保留公式编号；多行公式用 \\\\ 分隔。',
    '3. 使用标准 LaTeX 命令；不要输出 Markdown、美元符号或代码围栏。',
    '4. 无法确认的符号不要猜，confidence 降到 0.5 以下。',
    '只返回 JSON：{"latex":"...","confidence":0.0到1.0,"warnings":["..."]}',
  ].join('\n')
}

export function normalizeFormulaResult(value) {
  let latex = String(value?.latex || '').trim()
  latex = latex.replace(/^```(?:latex|tex)?\s*/i, '').replace(/\s*```$/, '')
  latex = latex.replace(/^\$\$?|\$\$?$/g, '').trim()
  if (!latex || latex.length > 4000) {
    return { latex: '', confidence: 0, warnings: ['empty-or-too-long'], valid: false }
  }
  const warnings = Array.isArray(value?.warnings)
    ? value.warnings.map((entry) => cleanCell(entry, 160)).filter(Boolean).slice(0, 6)
    : []
  if ((latex.match(/\{/g) || []).length !== (latex.match(/\}/g) || []).length) {
    warnings.push('unbalanced-braces')
  }
  if (/\\begin\{document\}|\\end\{document\}/.test(latex)) warnings.push('document-wrapper')
  const confidence = Math.max(0, Math.min(1, Number(value?.confidence) || 0))
  const valid = warnings.length === 0 && confidence >= 0.5
  return { latex, confidence, warnings: [...new Set(warnings)], valid }
}

export function tablePrompt(block, targetLang = 'zh-CN') {
  return [
    '把这张学术论文表格裁剪图整理成结构化行，并把文字单元格翻译为' + targetLang + '。',
    '表格标签：' + String(block?.label || 'Table'),
    '页码：' + String(block?.page || ''),
    '题注：' + cleanCell(block?.caption, 500),
    'PDF 文本层（仅用于核对数字与专名，可能有顺序噪声）：',
    cleanCell(block?.tableText || block?.text, 6000),
    '要求：',
    '1. 按视觉行列输出，保持每个单元格的原意；数字、单位、范围、符号、引用编号、DOI 原样保留。',
    '2. 只翻译自然语言；专有名词、基因名、缩写、变量名保持原样。',
    '3. 合并单元格用空字符串占位，不要凭空新增行列。',
    '4. 所有数字必须出现在给定文本层里；不确定时宁可不译该单元格。',
    '5. 表头也翻译，但保留单位方括号。',
    '只返回 JSON：{"rows":[{"header":true,"cells":["..."]}],"warnings":["..."]}',
  ].join('\n')
}

export function tableSlicePrompt(block, index, total, targetLang = 'zh-CN') {
  return [
    '这是密集表格的纵向切片 ' + (index + 1) + '/' + total + '。',
    '只识别本切片中清楚可见的行，并把自然语言单元格翻译为' + targetLang + '。',
    '数字、单位、范围、基因名、缩写和变量名原样保留；切片边缘不完整的行可以省略。',
    '本切片如果包含表头，标记 header=true；否则只输出正文行。',
    '不要补全图片外的行，不要猜测模糊数字。',
    '只返回 JSON：{"rows":[{"header":false,"cells":["..."]}],"warnings":["..."]}',
  ].join('\n')
}

export function buildTableTextBatches(text, { maxRows = 12 } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^[.\s]+$/.test(line))
  if (lines.length < 4) return []
  const headerIndex = lines.findIndex((line) => /\bStrain\b.*\bOrganism\b.*\bState\b/i.test(line))
  if (headerIndex < 0) return []
  const headerLines = lines.slice(headerIndex, Math.min(lines.length, headerIndex + 2))
  const body = lines.slice(headerIndex + headerLines.length)
  if (!body.length) return []
  const batches = []
  for (let start = 0; start < body.length; start += maxRows) {
    batches.push({
      headerLines,
      bodyLines: body.slice(start, start + maxRows),
      includeHeader: start === 0,
    })
  }
  return batches
}

export function tableTextPrompt(block, batch, targetLang = 'zh-CN') {
  return [
    '把下面从 PDF 阅读顺序提取出的表格文本重建为行列，并把自然语言单元格翻译为' + targetLang + '。',
    '表格标签：' + String(block?.label || 'Table') + '；页码：' + String(block?.page || ''),
    '表头：',
    batch.headerLines.join('\n'),
    '本批正文行：',
    batch.bodyLines.join('\n'),
    '要求：',
    '1. 每个输入正文行输出一行；不要把两行合并，也不要新增输入中不存在的行。',
    '2. 按表头列拆分 cells；数字、单位、年份、菌株号、基因名、缩写和符号原样保留。',
    '3. 本批' + (batch.includeHeader ? '包含表头，先输出 header=true 的表头行。' : '不重复表头，只输出正文行。'),
    '4. 不确定的模糊字符宁可保留原文。',
    '只返回 JSON：{"rows":[{"header":false,"cells":["..."]}],"warnings":["..."]}',
  ].join('\n')
}

const ROTATED_HEADER = [
  '菌株',
  '菌种',
  '州',
  '年份',
  '来源',
  '耐药表型',
  ...Array(13).fill(''),
  'IncA/C PCR 谱',
  ...Array(11).fill(''),
  '接合转移频率',
]

const ROTATED_SUBHEADER = [
  '',
  '',
  '',
  '',
  '',
  'A',
  'C',
  'S',
  'Su',
  'T',
  'Ti',
  'G',
  'K',
  'Ag',
  'Ax',
  'N',
  'Ak',
  'Cp',
  'Sxt',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '',
]

const SOURCE_LABELS = {
  Turkey: '火鸡肉',
  Chicken: '鸡肉',
  Beef: '牛肉',
  Pork: '猪肉',
  Calf: '犊牛',
}

export function parseRotatedTableGrid(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const rows = [
    { header: true, cells: [...ROTATED_HEADER] },
    { header: true, cells: [...ROTATED_SUBHEADER] },
  ]
  for (const line of lines) {
    const match = /^(\S+)\s+(.+?)\s+([A-Z]{2})\s+(\d{4})\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const [, strain, organism, state, year, source, rest] = match
    const tokens = rest.split(/\s+/).filter(Boolean)
    if (tokens.length < 26) continue
    const phenotype = tokens.slice(0, 14)
    let cursor = 14
    const pcr = []
    while (cursor < tokens.length && pcr.length < 12) {
      const token = tokens[cursor++]
      if (/^-+$/.test(token)) {
        pcr.push(...Array.from({ length: token.length }, () => '-'))
      } else if (token === '10' || token === '11' || token === '12') {
        pcr.push(token)
      } else if (/^[1-9]+$/.test(token) && token.length > 1) {
        pcr.push(...token.split(''))
      } else if (/^[1-9]$/.test(token)) {
        pcr.push(token)
      } else {
        break
      }
    }
    if (pcr.length !== 12) continue
    rows.push({
      header: false,
      cells: [
        strain,
        organism,
        state,
        year,
        SOURCE_LABELS[source] || source,
        ...phenotype,
        ...pcr,
        tokens.slice(cursor).join(' ') || '-',
      ],
    })
  }
  return rows.length > 2 ? rows : []
}

function numericTokens(text) {
  return [...String(text ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0])
}

function numericCounts(text) {
  const counts = new Map()
  for (const token of numericTokens(text)) counts.set(token, (counts.get(token) || 0) + 1)
  return counts
}

export function normalizeTableResult(value, sourceText) {
  const rawRows = Array.isArray(value?.rows) ? value.rows : []
  const rows = rawRows
    .slice(0, 80)
    .map((row) => {
      const cells = Array.isArray(row?.cells)
        ? row.cells.slice(0, 40).map((cell) => cleanCell(cell, 320))
        : []
      return { header: Boolean(row?.header), cells }
    })
    .filter((row) => row.cells.length > 0 && row.cells.some(Boolean))
  if (rows.length === 0) {
    return { rows: [], warnings: ['empty-table'], valid: false }
  }
  const targetText = rows.flatMap((row) => row.cells).join(' ')
  const sourceCounts = numericCounts(sourceText)
  const targetCounts = numericCounts(targetText)
  const hallucinated = [...targetCounts.keys()].filter((token) => !sourceCounts.has(token))
  const missing = [...sourceCounts.keys()].filter((token) => !targetCounts.has(token))
  const warnings = []
  if (hallucinated.length) warnings.push('hallucinated-numbers:' + hallucinated.slice(0, 8).join(','))
  if (missing.length) warnings.push('missing-numbers:' + missing.slice(0, 8).join(','))
  const sourceHasWords = /[A-Za-z]{3}/.test(String(sourceText || ''))
  if (sourceHasWords && !/[\u3400-\u9fff]/.test(targetText)) warnings.push('no-cjk')
  const supplied = Array.isArray(value?.warnings)
    ? value.warnings.map((entry) => cleanCell(entry, 160)).filter(Boolean).slice(0, 8)
    : []
  warnings.push(...supplied)
  return {
    rows,
    warnings: [...new Set(warnings)],
    valid: hallucinated.length === 0,
  }
}

export function mergeTableSlices(parts) {
  const headerRows = []
  const bodyRows = []
  const seen = new Set()
  for (const [partIndex, part] of (parts || []).entries()) {
    for (const row of part?.rows || []) {
      const cells = (row.cells || []).map((cell) => cleanCell(cell, 320))
      const signature = cells.join('\u0000').toLowerCase()
      if (!cells.some(Boolean) || seen.has(signature)) continue
      if (row.header && partIndex === 0) {
        seen.add(signature)
        headerRows.push({ header: true, cells })
      } else if (!row.header) {
        seen.add(signature)
        bodyRows.push({ header: false, cells })
      }
    }
  }
  return {
    rows: [...headerRows, ...bodyRows],
    warnings: (parts || []).flatMap((part) => part?.warnings || []).slice(0, 24),
  }
}

export function visualCacheKey(kind, payload, version, model) {
  return createHash('sha256')
    .update([kind, version, model, JSON.stringify(payload)].join('\u0000'))
    .digest('hex')
    .slice(0, 24)
}
