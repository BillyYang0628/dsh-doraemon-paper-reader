// 宿主半区：PDF 导入、后台抄写任务与批注批次读写。
//
// 职责边界：
//   - 浏览器只上传原始 PDF 字节；不把文件路径交给前端；
//   - 任务在 DSH 进程内运行（内存 Map），只要 DSH 不关闭就继续；
//   - Python 只作为本地转换器，进度通过 stderr 的 DPR_PROGRESS 行回传；
//   - 所有文件访问都限制在 $DSH_HOME/doraemon-paper-reader/ 下；
//   - 批注批次只接受 `batch_` + 24 位十六进制，避免把用户输入拼进文件路径。

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BATCH_ID_RE, MAX_ANNOTATION_BYTES } from './annotations.js'
import {
  buildCitationIndex,
  buildCitationPrompt,
  buildCitedDigest,
  citationContextHash,
  extractReferenceFields,
  normalizeCitationAnalysis,
} from './citations.js'
import {
  buildCitationPrompt as buildCompareCitationPrompt,
  buildCompareChatPrompt,
  buildChartPrompt,
  buildConceptPrompt,
  buildCompareMessage,
  buildSurveyPrompt,
  buildVersionDiff,
  compareKey,
  normalizeCitationVerdict,
  normalizeChartSpec,
  normalizeConceptSpec,
  normalizeComparisonTable,
} from './compare.js'
import { createPaperDigestReader } from './digest.js'
import { chatJson, chatText, visionJson } from './llm.js'
import { resolveLookup } from './lookup.js'
import { createPythonRuntime } from './python-runtime.js'
import {
  DEFAULT_TARGET_LANG,
  TRANSLATION_PROMPT_VERSION,
  assembleTranslations,
  auditTranslations,
  buildTranslationPrompt,
  buildTranslationUnits,
  chunkTasks,
  flattenTasks,
  parseTranslationResponse,
  protectCitations,
  restoreCitations,
  translationCacheKey,
  validateTranslation,
} from './translations.js'
import { extractGlossary, glossaryHash, normalizeGlossary, promptGlossary } from './glossary.js'
import {
  buildTermLookupPrompt,
  extractTermSentence,
  findLocalTermEvidence,
  normalizeSelectedTerm,
  normalizeTermLookup,
  termLookupKey,
} from './terms.js'
import {
  FORMULA_PROMPT_VERSION,
  TABLE_PROMPT_VERSION,
  buildTableTextBatches,
  formulaPrompt,
  mergeTableSlices,
  normalizeFormulaResult,
  normalizeTableResult,
  parseRotatedTableGrid,
  tableSlicePrompt,
  tableTextPrompt,
  tablePrompt,
} from './visual.js'
import {
  REVIEW_PROMPT_VERSION,
  applyReviewRevisions,
  applyRepairSuggestions,
  buildBackTranslationPrompt,
  buildIssueRepairPrompt,
  buildSemanticReviewPrompt,
  chunkReviewTasks,
  collectReviewSegments,
  normalizeReviewIssues,
  parseBackTranslations,
} from './review.js'

export const API_PREFIX = '/doraemon-paper-reader/api/'
/** WebServer 注册用：前缀路由不能带尾斜杠。 */
export const API_ROUTE_PREFIX = '/doraemon-paper-reader/api'
export const MAX_PDF_BYTES = 200 * 1024 * 1024
export const MAX_HTML_BYTES = 20 * 1024 * 1024
export const MAX_LOOKUP_BYTES = 64 * 1024
export const MAX_CITATION_BYTES = 128 * 1024
export const MAX_COMPARE_BYTES = 128 * 1024
export const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp|jpe?g|svg)$/i
const SOURCE_PAGE_RE = /^page-\d{2}\.png$/

/**
 * 把用户给的文件名压成安全 basename；保留中文，但去掉路径与宿主非法字符。
 * @param {string} raw - X-DPR-Filename（可能经过 encodeURIComponent）。
 * @returns {string} 以 .pdf 结尾的安全文件名。
 */
export function cleanOriginalName(raw) {
  let value = String(raw ?? 'paper.pdf')
  try {
    value = decodeURIComponent(value)
  } catch {
    // 保留原值；下面的字符清洗仍会兜底。
  }
  value = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  if (!value) value = 'paper.pdf'
  if (!value.toLowerCase().endsWith('.pdf')) value += '.pdf'
  return value.slice(0, 180)
}

/**
 * 只接受 PDF 魔数；不信任扩展名与 Content-Type。
 * @param {Buffer} buffer - 上传内容。
 * @returns {boolean} 是否像 PDF。
 */
export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

/**
 * 解析 API 路径。返回值只描述意图，不做文件访问。
 * @param {string | undefined} rawUrl - req.url。
 * @returns {{type: string, jobId?: string, file?: string, folder?: string, name?: string} | null}
 */
export function routeRequest(rawUrl) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(rawUrl ?? '/', 'http://localhost').pathname)
  } catch {
    return null
  }
  if (!pathname.startsWith(API_PREFIX)) return null
  const parts = pathname.slice(API_PREFIX.length).split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'open') return { type: 'citation-open' }
  if (parts.length === 1 && parts[0] === 'import') return { type: 'import' }
  if (parts.length === 2 && parts[0] === 'lookup' && parts[1] === 'resolve') return { type: 'lookup-resolve' }
  if (parts.length === 2 && parts[0] === 'lookup' && parts[1] === 'fetch') return { type: 'lookup-fetch' }
  if (parts.length === 2 && parts[0] === 'citations' && parts[1] === 'resolve') return { type: 'citation-resolve' }
  if (parts.length === 2 && parts[0] === 'citations' && parts[1] === 'analyze') return { type: 'citation-analyze' }
  if (parts.length === 2 && parts[0] === 'citations' && parts[1] === 'promote') return { type: 'citation-promote' }
  if (parts.length === 1 && parts[0] === 'library') return { type: 'library' }
  if (parts.length === 1 && parts[0] === 'maintenance') return { type: 'maintenance' }
  if (parts.length === 2 && parts[0] === 'maintenance' && parts[1] === 'python') {
    return { type: 'maintenance-python' }
  }
  if (parts.length === 2 && parts[0] === 'maintenance' && parts[1] === 'cleanup') {
    return { type: 'maintenance-cleanup' }
  }
  if (parts.length === 2 && parts[0] === 'compare') {
    if (parts[1] === 'digests') return { type: 'compare-digests' }
    if (parts[1] === 'table') return { type: 'compare-table' }
    if (parts[1] === 'citation') return { type: 'compare-citation' }
    if (parts[1] === 'packet') return { type: 'compare-packet' }
    if (parts[1] === 'ask') return { type: 'compare-ask' }
    if (parts[1] === 'version-diff') return { type: 'compare-version-diff' }
    if (parts[1] === 'chart') return { type: 'compare-chart' }
    if (parts[1] === 'concept') return { type: 'compare-concept' }
    if (parts[1] === 'archive') return { type: 'compare-archive' }
    if (parts[1] === 'archives') return { type: 'compare-archives' }
    return { type: 'unknown' }
  }
  if (parts.length === 1 && parts[0] === 'annotation-batches') return { type: 'annotation-save' }
  if (parts[0] === 'annotation-batches') {
    if (parts.length === 2 && BATCH_ID_RE.test(parts[1])) {
      return { type: 'annotation-read', batchId: parts[1] }
    }
    return { type: 'unknown' }
  }
  if (parts[0] !== 'jobs' || !parts[1]) return { type: 'unknown' }
  if (!JOB_ID_RE.test(parts[1])) return { type: 'unknown' }
  if (parts.length === 2) return { type: 'status', jobId: parts[1] }
  if (parts.length === 3 && parts[2] === 'citations') {
    return { type: 'citation-index', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'translate') {
    return { type: 'translation', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'review') {
    return { type: 'translation-review', jobId: parts[1] }
  }
  if (parts.length === 4 && parts[2] === 'review' && parts[3] === 'decisions') {
    return { type: 'translation-review-decision', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'translations') {
    return { type: 'translations-file', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'formulas') {
    return { type: 'formulas', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'formula-render') {
    return { type: 'formula-render', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'versions') {
    return { type: 'versions', jobId: parts[1] }
  }
  if (parts.length === 4 && parts[2] === 'formulas' && /^[A-Za-z0-9_-]{1,80}$/.test(parts[3])) {
    return { type: 'formula-block', jobId: parts[1], blockId: parts[3] }
  }
  if (parts.length === 3 && parts[2] === 'tables') {
    return { type: 'tables', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'glossary') {
    return { type: 'glossary', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'term-lookup') {
    return { type: 'term-lookup', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'version') {
    return { type: 'version', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'cancel-task') {
    return { type: 'cancel-task', jobId: parts[1] }
  }
  if (parts.length === 3 && parts[2] === 'annotations') {
    return { type: 'annotations', jobId: parts[1] }
  }
  if (
    parts.length === 3 &&
    (parts[2] === 'mirrordoc.json' || parts[2] === 'paper.html' || parts[2] === 'paper-summary.json')
  ) {
    return { type: 'file', jobId: parts[1], file: parts[2] }
  }
  if (
    parts.length === 4 &&
    (parts[2] === 'assets' || parts[2] === 'source-pages') &&
    ((parts[2] === 'assets' && ASSET_NAME_RE.test(parts[3])) ||
      (parts[2] === 'source-pages' && SOURCE_PAGE_RE.test(parts[3])))
  ) {
    return { type: 'asset', jobId: parts[1], folder: parts[2], name: parts[3] }
  }
  return { type: 'unknown' }
}

/**
 * 把路由里的相对路径落到 job 目录内，并拒绝越界。
 * @param {string} jobDir - 该任务的绝对目录。
 * @param {{type: string, file?: string, folder?: string, name?: string}} route - 已解析路由。
 * @returns {string | null} 可读文件绝对路径或 null。
 */
export function safeJobFile(jobDir, route) {
  let relative = ''
  if (route.type === 'file') {
    if (
      route.file !== 'mirrordoc.json' &&
      route.file !== 'paper.html' &&
      route.file !== 'paper-summary.json'
    ) {
      return null
    }
    relative = route.file
  } else if (route.type === 'asset') {
    if (
      (route.folder === 'assets' && !ASSET_NAME_RE.test(route.name ?? '')) ||
      (route.folder === 'source-pages' && !SOURCE_PAGE_RE.test(route.name ?? '')) ||
      (route.folder !== 'assets' && route.folder !== 'source-pages')
    ) {
      return null
    }
    relative = `${route.folder}/${route.name}`
  }
  else return null
  const root = path.resolve(jobDir)
  const full = path.resolve(root, relative)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

/**
 * @param {string} file - 文件路径。
 * @returns {string} 响应 Content-Type。
 */
export function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.webp')) return 'image/webp'
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg'
  return 'application/octet-stream'
}

/**
 * 读取请求体，超过上限立即拒绝。
 * @param {import('node:http').IncomingMessage} req - 上传请求。
 * @param {number} maxBytes - 上限。
 * @param {string} [label] - 错误文案里的对象名。
 * @returns {Promise<Buffer>} 请求体。
 */
function readBody(req, maxBytes, label = '请求体') {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        const limit = maxBytes >= 1024 * 1024 ? Math.round(maxBytes / 1024 / 1024) + ' MB' : maxBytes + ' 字节'
        fail(Object.assign(new Error(label + ' 超过 ' + limit + ' 上限'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => fail(error))
  })
}

/**
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态。
 * @param {object} body - JSON 内容。
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态。
 * @param {string} message - 错误文本。
 */
function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

/**
 * 读一个小 JSON 请求体；格式错直接给 400，不把解析细节带进响应。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} maxBytes - 上限。
 * @param {string} label - 错误文案里的对象名。
 * @returns {Promise<object>} 解析后的对象。
 */
async function readJsonBody(req, maxBytes, label) {
  const body = await readBody(req, maxBytes, label)
  try {
    const value = JSON.parse(body.toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('不是对象')
    }
    return value
  } catch {
    throw Object.assign(new Error(label + '不是合法 JSON 对象'), { statusCode: 400 })
  }
}

/**
 * 创建 PDF 导入 API 与后台任务管理器。
 * @param {object} options - 配置。
 * @param {string} options.packageRoot - 包根目录。
 * @param {string} options.dataRoot - 数据根目录（$DSH_HOME/doraemon-paper-reader）。
 * @param {{save: Function, read: Function}} [options.annotations] - 批注批次仓库。
 * @param {string} [options.python] - Python 可执行文件。
 * @param {number} [options.dpi] - 裁剪 DPI。
 * @param {Function} [options.spawnImpl] - 测试注入的 spawn。
 * @returns {{handler: Function, dispose: Function, jobs: Map<string, object>}} API。
 */
export function createPaperApi({
  packageRoot,
  dataRoot,
  annotations,
  python = process.env.DPR_PYTHON || 'python',
  dpi = 200,
  spawnImpl = spawn,
  fetchImpl = fetch,
  chatJsonImpl = chatJson,
  chatTextImpl = chatText,
  visionJsonImpl = visionJson,
  digestReader = null,
  pythonRuntime = null,
}) {
  const jobs = new Map()
  const children = new Set()
  const jobsRoot = path.join(dataRoot, 'jobs')
  const comparisonsRoot = path.join(dataRoot, 'comparisons')
  const compareArchivesRoot = path.join(dataRoot, 'compare-archives')
  const previewJobsRoot = path.join(dataRoot, 'citation-previews')
  const citationAnalysisRoot = path.join(dataRoot, 'citation-analyses')
  const citationCardsRoot = path.join(dataRoot, 'citation-cards')
  const termLookupCache = new Map()
  const annotationsFile = 'annotations.json'
  const maxSavedAnnotationsBytes = 512 * 1024
  const extractor = path.join(packageRoot, '工具', 'pdf-pipeline', 'extract_pdf.py')
  const renderer = path.join(packageRoot, '工具', 'pdf-pipeline', 'render_html.py')
  const reconciler = path.join(packageRoot, '工具', 'pdf-pipeline', 'reconcile_layout.py')
  const htmlExtractor = path.join(packageRoot, '工具', 'html-pipeline', 'extract_html.py')
  const papersDigestReader = digestReader || createPaperDigestReader({ jobsRoot })
  const managedPythonRuntime =
    pythonRuntime ||
    (spawnImpl === spawn
      ? createPythonRuntime({
          dataRoot,
          packageRoot,
          basePython: python,
          spawnImpl,
        })
      : null)
  const resolvePython = async () =>
    managedPythonRuntime ? (await managedPythonRuntime.ensure()).executable : python

  const directoryUsage = async (root) => {
    let bytes = 0
    let files = 0
    const visit = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const target = path.join(dir, entry.name)
        if (entry.isDirectory()) await visit(target)
        else if (entry.isFile()) {
          try {
            bytes += (await stat(target)).size
            files += 1
          } catch {
            // 文件可能刚被清理。
          }
        }
      }
    }
    await visit(root)
    return { bytes, files }
  }

  const jobDirectories = async () => {
    try {
      const entries = await readdir(jobsRoot, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory() && JOB_ID_RE.test(entry.name)).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  const maintenanceSnapshot = async () => {
    const jobs = await jobDirectories()
    let vision = { bytes: 0, files: 0 }
    let translation = { bytes: 0, files: 0 }
    for (const jobId of jobs) {
      const jobDir = path.join(jobsRoot, jobId)
      const cache = await directoryUsage(path.join(jobDir, 'vision-cache'))
      vision = { bytes: vision.bytes + cache.bytes, files: vision.files + cache.files }
      try {
        const info = await stat(path.join(jobDir, translationCacheFile))
        translation = { bytes: translation.bytes + info.size, files: translation.files + 1 }
      } catch {
        // 没有译文缓存。
      }
    }
    const [jobUsage, batchUsage, archiveUsage, comparisons, analyses, cards] = await Promise.all([
      directoryUsage(jobsRoot),
      directoryUsage(path.join(dataRoot, 'annotation-batches')),
      directoryUsage(compareArchivesRoot),
      directoryUsage(comparisonsRoot),
      directoryUsage(citationAnalysisRoot),
      directoryUsage(citationCardsRoot),
    ])
    const caches = {
      comparisons,
      citationAnalyses: analyses,
      citationCards: cards,
      vision,
      translation,
    }
    caches.totalBytes = Object.values(caches).reduce((sum, item) => sum + (item.bytes || 0), 0)
    caches.totalFiles = Object.values(caches).reduce((sum, item) => sum + (item.files || 0), 0)
    return {
      at: new Date().toISOString(),
      dataRoot,
      jobs: { count: jobs.length, ...jobUsage },
      protectedData: {
        annotations: batchUsage,
        compareArchives: archiveUsage,
      },
      caches,
      python: managedPythonRuntime
        ? await managedPythonRuntime.inspect()
        : { status: 'external', executable: python, envRoot: '' },
    }
  }

  const cleanupCaches = async (scopes) => {
    const allowed = new Set(['comparisons', 'citationAnalyses', 'citationCards', 'vision', 'translation'])
    const selected = [...new Set((Array.isArray(scopes) ? scopes : []).map(String))].filter((scope) =>
      allowed.has(scope),
    )
    if (selected.length === 0) {
      throw Object.assign(new Error('请选择要清理的可重建缓存'), { statusCode: 400 })
    }
    const before = await maintenanceSnapshot()
    const jobs = await jobDirectories()
    for (const scope of selected) {
      if (scope === 'comparisons') await rm(comparisonsRoot, { recursive: true, force: true })
      else if (scope === 'citationAnalyses') await rm(citationAnalysisRoot, { recursive: true, force: true })
      else if (scope === 'citationCards') await rm(citationCardsRoot, { recursive: true, force: true })
      else if (scope === 'vision') {
        for (const jobId of jobs) {
          await rm(path.join(jobsRoot, jobId, 'vision-cache'), { recursive: true, force: true })
        }
      } else if (scope === 'translation') {
        for (const jobId of jobs) {
          await rm(path.join(jobsRoot, jobId, translationCacheFile), { force: true })
        }
      }
    }
    const after = await maintenanceSnapshot()
    return {
      ok: true,
      scopes: selected,
      freedBytes: Math.max(0, before.caches.totalBytes - after.caches.totalBytes),
      before,
      after,
    }
  }

  /**
   * 找一篇论文的作业目录：内存里优先，重启后回退到磁盘。
   * 只认带 mirrordoc.json 的完整作业，避免把半成品目录当论文打开。
   * @param {string} jobId - 作业 id。
   * @returns {Promise<string|null>} 绝对目录或 null。
   */
  const jobDirFor = async (jobId) => {
    if (!JOB_ID_RE.test(jobId)) return null
    const live = jobs.get(jobId)
    if (live) return live.dir
    for (const root of [jobsRoot, previewJobsRoot]) {
      const dir = path.join(root, jobId)
      try {
        const info = await stat(path.join(dir, 'mirrordoc.json'))
        if (info.isFile()) return dir
      } catch {
        // 继续看下一个根目录。
      }
    }
    return null
  }

  /** 读一篇论文的持久化批注；没有文件时返回空存档。 */
  const readAnnotations = async (jobDir, jobId) => {
    try {
      const payload = JSON.parse(await readFile(path.join(jobDir, annotationsFile), 'utf8'))
      return {
        version: 1,
        jobId,
        updatedAt: payload?.updatedAt || null,
        items: Array.isArray(payload?.items) ? payload.items : [],
      }
    } catch (cause) {
      if (cause?.code === 'ENOENT') return { version: 1, jobId, updatedAt: null, items: [] }
      throw cause
    }
  }

  /** 写一篇论文的持久化批注；按 jobId 隔离，单篇上限 512 KB。 */
  const writeAnnotations = async (jobDir, jobId, payload) => {
    const items = payload?.items
    if (!Array.isArray(items)) {
      throw Object.assign(new Error('批注存档必须是 { items: [...] }'), { statusCode: 400 })
    }
    if (items.length > 300) {
      throw Object.assign(new Error('单篇论文的批注存档最多 300 条'), { statusCode: 400 })
    }
    for (const item of items) {
      if (item && typeof item === 'object' && item.jobId && item.jobId !== jobId) {
        throw Object.assign(new Error('批注存档里混入了别的论文'), { statusCode: 400 })
      }
    }
    const record = {
      version: 1,
      jobId,
      updatedAt: new Date().toISOString(),
      items,
    }
    const serialized = JSON.stringify(record, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > maxSavedAnnotationsBytes) {
      throw Object.assign(new Error('批注存档超过 512 KB 上限'), { statusCode: 413 })
    }
    await writeFile(path.join(jobDir, annotationsFile), serialized, 'utf8')
    return record
  }

  /** 扫描作业目录，生成论文库列表；不把绝对路径发给浏览器。 */
  const listLibrary = async () => {
    let entries
    try {
      entries = await readdir(jobsRoot, { withFileTypes: true })
    } catch (cause) {
      if (cause?.code === 'ENOENT') return []
      throw cause
    }
    const papers = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue
      const dir = path.join(jobsRoot, entry.name)
      let summary = null
      try {
        summary = JSON.parse(await readFile(path.join(dir, 'paper-summary.json'), 'utf8'))
      } catch {
        // 老作业没有 summary 时退回 mirrordoc.meta。
      }
      if (!summary) {
        try {
          const doc = JSON.parse(await readFile(path.join(dir, 'mirrordoc.json'), 'utf8'))
          summary = {
            title: doc?.meta?.title || '',
            authors: doc?.meta?.authors || '',
            identifiers: { doi: doc?.meta?.doi || '', arxiv: doc?.meta?.arxivId || '' },
            generatedAt: doc?.meta?.generatedAt || '',
          }
        } catch {
          continue
        }
      }
      if (!summary?.title) continue
      let archive = { items: [], updatedAt: null }
      try {
        archive = await readAnnotations(dir, entry.name)
      } catch {
        // 损坏的批注存档不应让整库列表失败；阅读页单独报错。
      }
      let info
      try {
        info = await stat(dir)
      } catch {
        continue
      }
      const updatedAt =
        archive.updatedAt || summary.generatedAt || info.mtime.toISOString()
      papers.push({
        jobId: entry.name,
        title: summary.title,
        authors: summary.authors || '',
        doi: summary.identifiers?.doi || '',
        arxiv: summary.identifiers?.arxiv || '',
        annotationCount: archive.items.length,
        sentCount: archive.items.filter((item) => item?.sent).length,
        updatedAt,
        createdAt: summary.generatedAt || info.birthtime.toISOString(),
        source: 'local-pdf',
      })
    }
    // 同一 DOI/arXiv/标题只留一个主条目，优先保留批注更多、更新时间更近的副本。
    const grouped = new Map()
    for (const paper of papers) {
      const identity = paper.doi
        ? 'doi:' + String(paper.doi).toLowerCase()
        : paper.arxiv
          ? 'arxiv:' + String(paper.arxiv).toLowerCase()
          : 'title:' + String(paper.title).toLowerCase().replace(/\s+/g, ' ').trim()
      const previous = grouped.get(identity)
      if (!previous) {
        grouped.set(identity, { ...paper, copies: 1 })
        continue
      }
      const candidateWins =
        paper.annotationCount > previous.annotationCount ||
        (paper.annotationCount === previous.annotationCount &&
          String(paper.createdAt).localeCompare(String(previous.createdAt)) > 0)
      const winner = candidateWins ? paper : previous
      grouped.set(identity, {
        ...winner,
        annotationCount: Math.max(previous.annotationCount, paper.annotationCount),
        copies: (previous.copies || 1) + 1,
      })
    }
    const unique = [...grouped.values()]
    unique.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return unique
  }

  /** 查询前先看论文库：同一 DOI/arXiv/标题已经有主条目就直接复用。 */
  const existingLibraryJob = async (metadata) => {
    const papers = await listLibrary()
    const doi = String(metadata?.doi || '').toLowerCase()
    const arxiv = String(metadata?.arxiv || '')
    const title = String(metadata?.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    const hit = papers.find(
      (paper) =>
        (doi && String(paper.doi || '').toLowerCase() === doi) ||
        (arxiv && String(paper.arxiv || '') === arxiv) ||
        (!doi && !arxiv && title && String(paper.title || '').toLowerCase().replace(/\s+/g, ' ').trim() === title),
    )
    return hit?.jobId || ''
  }

  /** 对照缓存文件名：键进 sha1，目录里不出现用户内容。 */
  const compareCacheFile = (key) =>
    path.join(comparisonsRoot, createHash('sha1').update(String(key)).digest('hex') + '.json')

  /** 读对照缓存；损坏就当没有，下一轮重算。 */
  const readCompareCache = async (key) => {
    try {
      const value = JSON.parse(await readFile(compareCacheFile(key), 'utf8'))
      return value && value.key === key ? value : null
    } catch {
      return null
    }
  }

  /** 写对照缓存；写失败不影响本次返回。 */
  const writeCompareCache = async (key, value) => {
    try {
      await mkdir(comparisonsRoot, { recursive: true })
      await writeFile(
        compareCacheFile(key),
        JSON.stringify({ ...value, key, savedAt: new Date().toISOString() }, null, 2),
        'utf8',
      )
    } catch (cause) {
      console.warn('[doraemon-paper-reader] 对照缓存写入失败：', cause?.message || cause)
    }
  }

  /** 对照至少两篇、最多三篇；由 digestReader 再校验一次 id 形状。 */
  const compareDigests = async (jobIds) => {
    const ids = Array.isArray(jobIds) ? jobIds.map((id) => String(id || '')).filter(Boolean) : []
    if (ids.length < 2) {
      throw Object.assign(new Error('多篇对照至少需要 2 篇论文'), { statusCode: 400 })
    }
    if (ids.length > 3) {
      throw Object.assign(new Error('一次最多对照 3 篇论文'), { statusCode: 400 })
    }
    return papersDigestReader.readDigests(ids)
  }

  /** 引用方 block 必须由宿主读，不能用浏览器传的 quote。 */
  const resolveCiting = async (jobIds, citing) => {
    const jobId = String(citing?.jobId || '')
    const blockId = String(citing?.blockId || '')
    if (!jobId || !blockId || !jobIds.includes(jobId)) {
      throw Object.assign(new Error('引用对照缺少引用方 jobId / blockId'), { statusCode: 400 })
    }
    const block = await papersDigestReader.readBlock(jobId, blockId)
    return {
      ...block,
      number: Number(citing?.number) || 0,
      title: String(citing?.title || ''),
    }
  }

  const publicJob = (job) => ({
    id: job.id,
    kind: job.kind || 'pdf-import',
    pipeline: job.pipeline || 'pdf',
    status: job.status,
    stage: job.stage,
    message: job.message,
    preview: Boolean(job.preview),
    originalName: job.originalName,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    coverage: job.coverage ?? null,
    metadata: job.metadata
      ? {
          title: job.metadata.title || '',
          authors: job.metadata.authors || [],
          doi: job.metadata.doi || '',
          arxiv: job.metadata.arxiv || '',
          officialUrl: job.metadata.officialUrl || '',
          license: job.metadata.license || '',
        }
      : null,
    source: job.metadata
      ? { route: job.route || (job.pipeline === 'html' ? 'arxiv-html' : ''), license: job.metadata.license || '' }
      : null,
    docUrl: API_PREFIX + 'jobs/' + job.id + '/mirrordoc.json',
    paperUrl: API_PREFIX + 'jobs/' + job.id + '/paper.html',
  })

  /**
   * 从磁盘恢复一个已完成作业的只读公开状态。
   * DSH 重启后内存 Map 会清空，但论文库、阅读页与批注都仍然有效；
   * 这里只恢复已落盘的完成态，不把未知进度伪造成 running。
   * @param {string} jobId - 作业 id。
   * @param {string} jobDir - 已确认含 mirrordoc.json 的作业目录。
   * @returns {Promise<object>} publicJob 形状的状态。
   */
  const publicJobFromDisk = async (jobId, jobDir) => {
    const [doc, summary, info] = await Promise.all([
      readJsonIfPresent(path.join(jobDir, 'mirrordoc.json')),
      readJsonIfPresent(path.join(jobDir, 'paper-summary.json')),
      stat(jobDir),
    ])
    if (!doc) throw Object.assign(new Error('mirrordoc.json 不在了。'), { statusCode: 404 })
    const generatedAt = summary?.generatedAt || doc?.meta?.generatedAt || info.mtime.toISOString()
    const authors = summary?.authors || doc?.meta?.authors || ''
    const doi = summary?.identifiers?.doi || doc?.meta?.doi || ''
    const arxiv = summary?.identifiers?.arxiv || doc?.meta?.arxivId || ''
    const preview = path.resolve(jobDir).startsWith(path.resolve(previewJobsRoot) + path.sep)
    const job = {
      id: jobId,
      kind: doc?.provenance?.mirrorKind === 'html' ? 'lookup-fetch' : 'pdf-import',
      pipeline: doc?.provenance?.mirrorKind === 'html' ? 'html' : 'pdf',
      status: 'done',
      stage: 'done',
      message: '从本地论文库恢复完成。',
      preview,
      originalName: summary?.originalName || '',
      startedAt: generatedAt,
      finishedAt: generatedAt,
      coverage: doc?.coverage ?? null,
      metadata: {
        title: summary?.title || doc?.meta?.title || '',
        authors,
        doi,
        arxiv,
        officialUrl: summary?.officialUrl || doc?.provenance?.officialUrl || '',
        license: summary?.license || doc?.provenance?.license || '',
      },
      route: summary?.route || doc?.provenance?.route || '',
    }
    return publicJob(job)
  }

  const update = (job, patch) => {
    Object.assign(job, patch)
  }

  const fail = (job, error) => {
    update(job, {
      status: 'failed',
      stage: 'failed',
      message: error?.message || String(error),
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    })
  }

  const runProcess = async (job, args, initialStage, initialMessage) => {
    update(job, { stage: initialStage, message: initialMessage })
    const executable = await resolvePython()
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawnImpl(executable, args, {
          cwd: packageRoot,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
      } catch (error) {
        reject(error)
        return
      }
      children.add(child)
      let stderr = ''
      let lineBuffer = ''
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        stderr = (stderr + text).slice(-6000)
        lineBuffer += text
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('DPR_PROGRESS ')) continue
          try {
            const event = JSON.parse(line.slice('DPR_PROGRESS '.length))
            if (event?.stage) update(job, { stage: String(event.stage), message: String(event.message ?? '') })
          } catch {
            // 进度行损坏不应影响转换本身。
          }
        }
      })
      child.on('error', (error) => {
        children.delete(child)
        reject(new Error(`无法启动 Python：${error.message}`))
      })
      child.on('close', (code) => {
        children.delete(child)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `转换器退出码 ${code}`))
      })
    })
  }

  /** 用 matplotlib mathtext 把公式预渲染成 SVG；单次任务级调用，带缓存。 */
  const renderFormulas = async (jobDir) => {
    const executable = await resolvePython()
    return new Promise((resolve, reject) => {
      const script = path.join(packageRoot, '工具', 'render_formulas.py')
      let child
      try {
        child = spawnImpl(executable, [script, jobDir], {
          cwd: packageRoot,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
      } catch (error) {
        reject(error)
        return
      }
      children.add(child)
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000)
      })
      child.on('error', (error) => {
        children.delete(child)
        reject(new Error('无法启动公式渲染：' + error.message))
      })
      child.on('close', (code) => {
        children.delete(child)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || '公式渲染退出码 ' + code))
      })
    })
  }

  const writeCiteStubs = async (job, doc) => {
    // 为每个块放一个轻量 .dprcite 导航桩：聊天里的相对路径链接由宿主
    // 文件打开器解析成 dsh-resource://file/...，再由阅读页签认领并滚动/高亮。
    const citeRoot = path.join(process.cwd(), 'work', 'doraemon-paper-cites', job.id)
    await mkdir(citeRoot, { recursive: true })
    for (const block of doc.blocks ?? []) {
      if (!block.id) continue
      await writeFile(
        path.join(citeRoot, block.id + '.dprcite'),
        JSON.stringify({ jobId: job.id, blockId: block.id }),
        'utf8',
      )
    }
  }

  const finishJob = (job, doc) => {
    update(job, {
      status: 'done',
      stage: 'done',
      message: '抄写完成，陛下请过目。',
      finishedAt: new Date().toISOString(),
      coverage: doc.coverage ?? null,
    })
  }

  const runPdfPipeline = async (job) => {
    await runProcess(
      job,
      [extractor, job.pdfPath, '--out', job.dir, '--dpi', String(dpi), '--progress'],
      'read',
      '小的我开始读 PDF…',
    )
    update(job, { stage: 'verify', message: '小的我复核表格与原版页…' })
    await runProcess(
      job,
      [reconciler, job.dir, '--progress'],
      'verify',
      '小的我复核表格与原版页…',
    )
    update(job, { stage: 'render', message: '小的我正在排版 HTML…' })
    await runProcess(
      job,
      [renderer, path.join(job.dir, 'mirrordoc.json'), '--out', path.join(job.dir, 'paper.html')],
      'render',
      '小的我正在排版 HTML…',
    )
    const doc = JSON.parse(await readFile(path.join(job.dir, 'mirrordoc.json'), 'utf8'))
    await writeCiteStubs(job, doc)
    return doc
  }

  const runJob = async (job) => {
    try {
      finishJob(job, await runPdfPipeline(job))
    } catch (error) {
      fail(job, error)
    }
  }

  /** 下载一个 URL，带超时、大小上限与 HTTP 状态；403 不重试。 */
  const fetchBuffer = async (url, maxBytes, kind, timeoutMs = 30000) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'dsh-doraemon-paper-reader/0.1.0 (local research tool)',
          Accept: 'text/html,application/pdf,image/*;q=0.8,*/*;q=0.5',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!response.ok) {
        throw Object.assign(new Error(kind + ' 返回 HTTP ' + response.status), { statusCode: response.status })
      }
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > maxBytes) {
        throw Object.assign(new Error(kind + ' 超过大小上限'), { statusCode: 413 })
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) {
        throw Object.assign(new Error(kind + ' 超过大小上限'), { statusCode: 413 })
      }
      return {
        buffer,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url || url,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** arXiv HTML 的图像是相对 URL；下载到 job/assets，再把 block.asset 指向本地文件。 */
  const materializeHtmlAssets = async (job) => {
    const docPath = path.join(job.dir, 'mirrordoc.json')
    const doc = JSON.parse(await readFile(docPath, 'utf8'))
    const assetsDir = path.join(job.dir, 'assets')
    await mkdir(assetsDir, { recursive: true })
    await Promise.allSettled(
      (doc.blocks ?? [])
        .filter((block) => block.assetSource)
        .map(async (block) => {
          try {
            const asset = (doc.assets ?? []).find((entry) => entry.blockId === block.id) || {}
            const name = path.basename(asset.name || 'figure' + (block.id || '') + '.png')
            const fetched = await fetchBuffer(block.assetSource, 8 * 1024 * 1024, '图片', 45000)
            await writeFile(path.join(assetsDir, name), fetched.buffer)
            block.asset = 'assets/' + name
            delete block.assetSource
            if (asset) {
              asset.path = block.asset
              delete asset.source
            }
          } catch (error) {
            console.warn('[doraemon-paper-reader] 图片下载失败（保留 caption）：', error?.message || error)
          }
        }),
    )
    await writeFile(docPath, JSON.stringify(doc, null, 2), 'utf8')
    return doc
  }

  /** 把 OpenAlex/arXiv 的来源、版本、许可 SHA256 写进 MirrorDoc 与 paper-summary。 */
  const patchLookupDoc = async (job, doc, metadata, route, fetchedAt, sha256) => {
    const authors = Array.isArray(metadata.authors) ? metadata.authors.join(', ') : metadata.authors || ''
    doc.meta = {
      ...doc.meta,
      title: metadata.title || doc.meta?.title || '',
      authors: authors || doc.meta?.authors || '',
      doi: metadata.doi || doc.meta?.doi || '',
      arxivId: metadata.arxiv || doc.meta?.arxivId || '',
      license: metadata.license || doc.meta?.license || '',
      generatedAt: fetchedAt,
      sha256,
    }
    doc.version = {
      ...(job.version || {}),
      source: route,
      license: metadata.license || '',
      fetchedAt,
      sha256,
      riskNote:
        route === 'arxiv-html' || route === 'arxiv-pdf'
          ? 'arXiv 预印本可能不是正式出版版本，引用前请核对正式版。'
          : 'OA 版可能不是正式出版版本，引用前请核对官网。',
    }
    doc.provenance = {
      input: job.input || {},
      resolvedIds: { doi: metadata.doi || '', arxiv: metadata.arxiv || '' },
      mirrorKind: route === 'arxiv-html' ? 'html' : 'pdf',
      channel: { route, success: true, url: job.sourceUrl || '' },
    }
    await writeFile(path.join(job.dir, 'mirrordoc.json'), JSON.stringify(doc, null, 2), 'utf8')
    const brief = doc.meta.brief || {}
    const summary = {
      ...brief,
      title: doc.meta.title,
      authors: doc.meta.authors,
      identifiers: { doi: doc.meta.doi || '', arxiv: doc.meta.arxivId || '' },
      generatedAt: fetchedAt,
    }
    await writeFile(path.join(job.dir, 'paper-summary.json'), JSON.stringify(summary, null, 2), 'utf8')
    return doc
  }

  const runHtmlLookup = async (job, metadata) => {
    update(job, { pipeline: 'html', stage: 'fetch', message: '小的我去 arXiv 取 HTML…' })
    const urls = [
      job.sourceUrl,
      metadata.arxiv ? 'https://ar5iv.labs.arxiv.org/html/' + metadata.arxiv : '',
    ].filter(Boolean)
    let fetched = null
    let lastError = null
    for (const url of urls) {
      try {
        const candidate = await fetchBuffer(url, MAX_HTML_BYTES, 'HTML')
        const text = candidate.buffer.toString('utf8')
        if (!/<html|<article/i.test(text)) throw new Error('返回内容不是 HTML')
        job.sourceUrl = candidate.finalUrl
        fetched = { ...candidate, text }
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!fetched) throw lastError || new Error('arXiv HTML 取回失败')
    const sourceDir = path.join(job.dir, 'source')
    await mkdir(sourceDir, { recursive: true })
    const htmlPath = path.join(sourceDir, 'paper.html')
    const metaPath = path.join(sourceDir, 'lookup.json')
    const fetchedAt = new Date().toISOString()
    const sha256 = createHash('sha256').update(fetched.buffer).digest('hex')
    await writeFile(htmlPath, fetched.buffer)
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          ...metadata,
          arxiv: metadata.arxiv || '',
          sourceUrl: job.sourceUrl,
          version: job.version,
          provenance: { mirrorKind: 'html', channel: { route: 'arxiv-html', url: job.sourceUrl } },
          generatedAt: fetchedAt,
          sha256,
        },
        null,
        2,
      ),
      'utf8',
    )
    update(job, { stage: 'extract', message: '小的我拆章节、图、表、公式…' })
    await runProcess(
      job,
      [htmlExtractor, htmlPath, '--out', job.dir, '--base-url', job.sourceUrl, '--meta', metaPath, '--progress'],
      'extract',
      '小的我拆章节、图、表、公式…',
    )
    let doc = await materializeHtmlAssets(job)
    doc = await patchLookupDoc(job, doc, metadata, 'arxiv-html', fetchedAt, sha256)
    update(job, { stage: 'render', message: '小的我正在排版 HTML…' })
    await runProcess(
      job,
      [renderer, path.join(job.dir, 'mirrordoc.json'), '--out', path.join(job.dir, 'paper.html')],
      'render',
      '小的我正在排版 HTML…',
    )
    await writeCiteStubs(job, doc)
    finishJob(job, doc)
  }

  const runPdfLookup = async (job, metadata, route) => {
    update(job, { pipeline: 'pdf', stage: 'fetch', message: '小的我去取合法 PDF…' })
    const fetched = await fetchBuffer(job.sourceUrl, MAX_PDF_BYTES, 'PDF', 60000)
    if (!isPdfBuffer(fetched.buffer)) throw new Error('下载内容不是 PDF')
    job.pdfPath = path.join(job.dir, 'original.pdf')
    await writeFile(job.pdfPath, fetched.buffer)
    const fetchedAt = new Date().toISOString()
    const sha256 = createHash('sha256').update(fetched.buffer).digest('hex')
    let doc = await runPdfPipeline(job)
    doc = await patchLookupDoc(job, doc, metadata, route, fetchedAt, sha256)
    update(job, { stage: 'render', message: '小的我正在排版 HTML…' })
    await runProcess(
      job,
      [renderer, path.join(job.dir, 'mirrordoc.json'), '--out', path.join(job.dir, 'paper.html')],
      'render',
      '小的我正在排版 HTML…',
    )
    await writeCiteStubs(job, doc)
    finishJob(job, doc)
  }

  const runLookupJob = async (job, resolution) => {
    try {
      if (resolution.route === 'arxiv-html') {
        try {
          await runHtmlLookup(job, resolution.metadata)
          return
        } catch (error) {
          if (!resolution.metadata.arxiv) throw error
          console.warn('[doraemon-paper-reader] arXiv HTML 失败，回退 PDF：', error?.message || error)
          job.sourceUrl = 'https://arxiv.org/pdf/' + resolution.metadata.arxiv
          job.route = 'arxiv-pdf'
          await runPdfLookup(job, resolution.metadata, 'arxiv-pdf')
          return
        }
      }
      await runPdfLookup(job, resolution.metadata, resolution.route)
    } catch (error) {
      fail(job, error)
    }
  }

  const createLookupJob = (resolution, fields, { preview = false } = {}) => {
    const jobId = randomUUID()
    const job = {
      id: jobId,
      dir: path.join(preview ? previewJobsRoot : jobsRoot, jobId),
      status: 'running',
      stage: 'queued',
      message: '小的我先去认论文…',
      startedAt: new Date().toISOString(),
      kind: 'lookup',
      preview,
      pipeline: resolution.route === 'arxiv-html' ? 'html' : 'pdf',
      metadata: resolution.metadata,
      version: resolution.version,
      sourceUrl: resolution.sourceUrl,
      route: resolution.route,
      input: {
        form: resolution.metadata.arxiv ? 'arxiv' : 'doi',
        value: resolution.metadata.arxiv || resolution.metadata.doi || fields.query || '',
      },
    }
    jobs.set(jobId, job)
    void mkdir(job.dir, { recursive: true })
      .then(() => runLookupJob(job, resolution))
      .catch((error) => fail(job, error))
    return job
  }

  const readJsonIfPresent = async (file) => {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  const updateJobVersion = async (jobId, payload) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const labels = {
      unknown: '版本未核验',
      vor: '正式版 VOR（用户确认）',
      accepted: '录用稿（用户确认）',
      preprint: '预印本（用户确认）',
    }
    const kind = String(payload?.kind || 'unknown')
    if (!(kind in labels)) {
      throw Object.assign(new Error('版本类型只接受 unknown/vor/accepted/preprint'), {
        statusCode: 400,
      })
    }
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    if (!doc) throw Object.assign(new Error('mirrordoc.json 不在了。'), { statusCode: 404 })
    const previous = doc.version || {}
    const version = {
      ...previous,
      kind,
      label: labels[kind],
      source: kind === 'unknown' ? previous.source || '' : 'user-confirmed',
      verifiedAt: kind === 'unknown' ? null : new Date().toISOString(),
      verifiedBy: kind === 'unknown' ? null : 'user',
    }
    doc.version = version
    await writeFile(path.join(jobDir, 'mirrordoc.json'), JSON.stringify(doc, null, 2), 'utf8')
    const summaryPath = path.join(jobDir, 'paper-summary.json')
    const summary = await readJsonIfPresent(summaryPath)
    if (summary) {
      summary.version = version
      await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    }
    return version
  }

  const citationIndexFor = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) return null
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    if (!doc) return null
    return buildCitationIndex(doc.blocks || [])
  }

  const matchingPreviewJob = (metadata) => {
    const doi = String(metadata?.doi || '').toLowerCase()
    const arxiv = String(metadata?.arxiv || '')
    const title = String(metadata?.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    return [...jobs.values()].find((job) => {
      if (!job.preview) return false
      const current = job.metadata || {}
      return (
        (doi && String(current.doi || '').toLowerCase() === doi) ||
        (arxiv && String(current.arxiv || '') === arxiv) ||
        (!doi && !arxiv && title && String(current.title || '').toLowerCase().replace(/\s+/g, ' ').trim() === title)
      )
    })
  }

  const citationResolve = async (body) => {
    const referenceText = String(body?.referenceText || '').trim()
    const number = Number(body?.number) || 0
    if (!referenceText || !number) {
      throw Object.assign(new Error('引用编号或参考文献原文为空'), { statusCode: 400 })
    }
    const contextHash = citationContextHash({
      jobId: body?.citing?.jobId || '',
      blockId: body?.citing?.blockId || '',
      quote: body?.citing?.quote || '',
      number,
      referenceText,
      referenceKey: body?.referenceKey || '',
    })
    const cachedCard = await readJsonIfPresent(path.join(citationCardsRoot, contextHash + '.json'))
    if (cachedCard?.analysis) {
      return { ...cachedCard, kind: 'cached', contextHash, cached: true }
    }
    const base = extractReferenceFields(referenceText)
    const fields = {
      doi: String(body?.doi || base.doi || ''),
      arxiv: String(body?.arxiv || base.arxiv || ''),
      title: String(body?.title || base.title || ''),
      authors: String(body?.authors || base.authors || ''),
      year: String(body?.year || base.year || ''),
      query: String(body?.query || base.query || ''),
    }
    const searchFields = fields.doi || fields.arxiv
      ? fields
      : {
          doi: '',
          arxiv: '',
          title: '',
          authors: '',
          venue: '',
          year: '',
          query: fields.title || fields.query,
        }
    const resolution = await resolveLookup(searchFields, {
      fetchImpl,
      existing: existingLibraryJob,
    })
    if (resolution.kind === 'existing') {
      return {
        kind: 'existing',
        jobId: resolution.existingJobId,
        metadata: resolution.metadata,
        version: resolution.version,
        reference: base,
        number,
      }
    }
    if (resolution.kind === 'exact') {
      const existingPreview = matchingPreviewJob(resolution.metadata)
      if (existingPreview) {
        return {
          kind: existingPreview.status === 'done' ? 'existing' : 'running',
          jobId: existingPreview.id,
          metadata: resolution.metadata,
          version: resolution.version || existingPreview.version,
          route: existingPreview.route,
          reference: base,
          number,
          reusedPreview: true,
        }
      }
      const job = createLookupJob(resolution, fields, { preview: true })
      return {
        kind: 'running',
        jobId: job.id,
        metadata: resolution.metadata,
        version: resolution.version,
        route: resolution.route,
        reference: base,
        number,
      }
    }
    return {
      ...resolution,
      reference: base,
      number,
    }
  }

  const citationAnalyze = async (body) => {
    const jobId = String(body?.jobId || '')
    const jobDir = jobId ? await jobDirFor(jobId) : null
    const job = jobId ? jobs.get(jobId) : null
    const doc = jobDir ? await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json')) : null
    const summary = jobDir ? await readJsonIfPresent(path.join(jobDir, 'paper-summary.json')) : null
    const metadata =
      job?.metadata ||
      body?.metadata ||
      {
        ...(summary || {}),
        doi: summary?.identifiers?.doi || doc?.meta?.doi || '',
        arxiv: summary?.identifiers?.arxiv || doc?.meta?.arxivId || '',
      }
    const digest = buildCitedDigest({
      doc,
      summary,
      abstract: body?.abstract || metadata?.abstract || '',
    })
    const referenceText = String(body?.referenceText || '').trim()
    const number = Number(body?.number) || 0
    const citing = body?.citing && typeof body.citing === 'object' ? body.citing : {}
    if (!referenceText || !number) {
      throw Object.assign(new Error('引用编号或参考文献原文为空'), { statusCode: 400 })
    }
    const cardHash = citationContextHash({
      jobId: citing?.jobId || '',
      blockId: citing?.blockId || '',
      quote: citing?.quote || '',
      number,
      referenceText,
      referenceKey: body?.referenceKey || '',
    })
    const baseHash = citationContextHash({
      jobId: citing?.jobId || '',
      blockId: citing?.blockId || '',
      quote: citing?.quote || '',
      number,
      referenceText,
      referenceKey: body?.baseReferenceKey || body?.referenceKey || '',
    })
    const cachePath = jobDir
      ? path.join(jobDir, 'citation-analysis-' + cardHash + '.json')
      : path.join(citationAnalysisRoot, cardHash + '.json')
    const cardCachePath = path.join(citationCardsRoot, cardHash + '.json')
    const baseCardCachePath = path.join(citationCardsRoot, baseHash + '.json')
    const cachedCard =
      (await readJsonIfPresent(cardCachePath)) ||
      (baseHash !== cardHash ? await readJsonIfPresent(baseCardCachePath) : null)
    if (cachedCard?.analysis) return { ...cachedCard, cached: true }
    if (cachePath) {
      const cached = await readJsonIfPresent(cachePath)
      if (cached) return { ...cached, cached: true }
    }

    let raw
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildCitationPrompt({
        referenceText,
        number,
        citing,
        digest:
          attempt === 0
            ? digest
            : { ...digest, text: digest.text.slice(0, 4200) },
      })
      try {
        raw = await chatJsonImpl({
          system: prompt.system,
          user: prompt.user,
          model: 'deepseek-chat',
          fetchImpl,
        })
        lastError = null
        break
      } catch (error) {
        lastError = error
        const retryable = /JSON|Unexpected|Unterminated|position/i.test(error?.message || '')
        if (attempt === 1 || !retryable) break
      }
    }
    if (lastError) {
      const error = lastError
      const status = error?.code === 'NO_API_KEY' ? 503 : 502
      throw Object.assign(
        new Error(
          error?.code === 'NO_API_KEY'
            ? '引用概览需要 DEEPSEEK_API_KEY；小的我先只展示元数据。'
            : '引用概览生成失败：' + (error?.message || String(error)),
        ),
        { statusCode: status },
      )
    }
    const analysis = normalizeCitationAnalysis(raw)
    const result = {
      ...analysis,
      basis: digest.basis,
      metadata: {
        title: metadata?.title || digest.title || '',
        authors: metadata?.authors || [],
        doi: metadata?.doi || '',
        arxiv: metadata?.arxiv || '',
        venue: metadata?.venue || '',
        year: metadata?.year || '',
        officialUrl: metadata?.officialUrl || metadata?.landingUrl || '',
      },
      version: job?.version || body?.version || null,
      referenceKey: body?.referenceKey || '',
      baseReferenceKey: body?.baseReferenceKey || '',
      schemaVersion: 2,
      savedAt: new Date().toISOString(),
      warnings: analysis.warnings,
      cached: false,
    }
    if (cachePath) {
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8')
    }
    await mkdir(citationCardsRoot, { recursive: true })
    const cardPayload = { ...result, analysis: result }
    await writeFile(cardCachePath, JSON.stringify(cardPayload, null, 2), 'utf8')
    if (baseHash !== cardHash) {
      await writeFile(baseCardCachePath, JSON.stringify(cardPayload, null, 2), 'utf8')
    }
    return result
  }

  const promotePreviewJob = async (jobId) => {
    const job = jobs.get(jobId)
    if (!job) throw Object.assign(new Error('预览任务不在了，请重新点一次引用。'), { statusCode: 404 })
    if (!job.preview) return { ...publicJob(job), promoted: false }
    const targetId = randomUUID()
    const targetDir = path.join(jobsRoot, targetId)
    await mkdir(jobsRoot, { recursive: true })
    await rename(job.dir, targetDir)
    jobs.delete(jobId)
    job.id = targetId
    job.dir = targetDir
    job.preview = false
    jobs.set(targetId, job)
    const doc = await readJsonIfPresent(path.join(targetDir, 'mirrordoc.json'))
    if (doc) await writeCiteStubs(job, doc)
    return { ...publicJob(job), promoted: true, jobId: targetId }
  }

  const translationJobs = new Map()
  const translationFile = 'translations.zh.json'
  const translationCacheFile = 'translations-cache.json'
  const glossaryFile = 'glossary.json'

  const readGlossary = async (jobDir, doc) => {
    const saved = await readJsonIfPresent(path.join(jobDir, glossaryFile))
    if (saved?.version === 7 && Array.isArray(saved.entries)) return normalizeGlossary(saved.entries)
    const entries = extractGlossary(doc)
    await writeFile(path.join(jobDir, glossaryFile), JSON.stringify({ version: 7, entries }, null, 2), 'utf8')
    return entries
  }

  /** 查词只读取已有术语表；没有文件时临时抽取，不落盘，不产生用户数据。 */
  const readGlossaryForLookup = async (jobDir, doc) => {
    const saved = await readJsonIfPresent(path.join(jobDir, glossaryFile))
    if (saved?.version === 7 && Array.isArray(saved.entries)) return normalizeGlossary(saved.entries)
    return extractGlossary(doc)
  }

  /**
   * 查词结果只在当前宿主进程内存中缓存，不落盘，不形成生词本或学习记录。
   */
  const lookupTerm = async (jobId, payload) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    if (!doc) throw Object.assign(new Error('这篇论文没有 MirrorDoc。'), { statusCode: 404 })
    const term = normalizeSelectedTerm(payload?.term)
    const blockId = String(payload?.blockId || '')
    let block = null
    if (blockId === '__meta_abstract') {
      block = {
        id: '__meta_abstract',
        type: 'abstract',
        text: doc?.meta?.abstract || '',
        page: 1,
        section: 'Abstract',
      }
    } else {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(blockId)) {
        throw Object.assign(new Error('查词需要有效的 blockId'), { statusCode: 400 })
      }
      block = (Array.isArray(doc.blocks) ? doc.blocks : []).find((item) => item?.id === blockId) || null
      if (!block) throw Object.assign(new Error('选区所在段落已经找不到'), { statusCode: 404 })
    }
    const paragraph = String(block.text || block.caption || '').replace(/\s+/g, ' ').trim()
    if (!paragraph) throw Object.assign(new Error('选区所在段落没有可解释文本'), { statusCode: 400 })
    if (!paragraph.toLowerCase().includes(term.toLowerCase())) {
      throw Object.assign(new Error('选中词不在这个段落里，请重新选择'), { statusCode: 400 })
    }
    const sentence = extractTermSentence(
      paragraph,
      term,
      String(payload?.before || '').slice(-300),
      String(payload?.after || '').slice(0, 300),
    )
    const glossary = await readGlossaryForLookup(jobDir, doc)
    const local = findLocalTermEvidence({
      term,
      blocks: Array.isArray(doc.blocks) ? doc.blocks : [],
      glossary,
      preferredBlockId: blockId,
    })
    const locator = {
      jobId,
      blockId,
      page: Number(block.page) || 0,
      section: String(block.section || '').slice(0, 100),
    }
    const cacheKey = termLookupKey({
      jobId,
      blockId,
      term,
      sentence,
      version: doc?.version?.kind || '',
      glossaryTarget: local.glossaryTarget,
    })
    const cached = termLookupCache.get(cacheKey)
    if (cached) return { lookup: { ...cached, cached: true }, paperTitle: doc?.meta?.title || '' }

    let raw = {}
    if (!local.glossaryTarget) {
      const prompt = buildTermLookupPrompt({
        term,
        sentence,
        paragraph,
        section: locator.section,
        paperTitle: doc?.meta?.title || '',
        local,
      })
      try {
        raw = await chatJsonImpl({
          system: prompt.system,
          user: prompt.user,
          maxTokens: prompt.maxTokens,
        })
      } catch (error) {
        if (!local.expanded) throw error
        raw = {
          contextMeaning: '论文中给出了全称，但没有可靠的中文语境解释。',
          confidence: 'medium',
          warnings: ['模型查词失败；仅返回论文内定义'],
        }
      }
    }
    const lookup = normalizeTermLookup(raw, {
      term,
      sentence,
      locator,
      local,
      source: local.glossaryTarget ? 'paper-glossary' : 'model-context',
    })
    if (termLookupCache.size >= 200) termLookupCache.delete(termLookupCache.keys().next().value)
    termLookupCache.set(cacheKey, lookup)
    return { lookup: { ...lookup, cached: false }, paperTitle: doc?.meta?.title || '' }
  }

  /** 用当前质量闸门重算旧译文，避免规则升级后仍显示过期告警。 */
  const refreshSavedTranslationQa = async (jobDir, saved, glossary) => {
    const qa = auditTranslations({
      blocks: saved.blocks,
      meta: saved.meta,
      glossary,
    })
    if (JSON.stringify(saved.qa || null) !== JSON.stringify(qa)) {
      saved.qa = qa
      await writeFile(path.join(jobDir, translationFile), JSON.stringify(saved, null, 2), 'utf8')
    }
    return qa
  }

  const translationStatus = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) return null
    const live = translationJobs.get(jobId)
    if (live) return live
    const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    const glossary = doc ? await readGlossary(jobDir, doc) : []
    const currentGlossaryHash = glossaryHash(glossary)
    if (
      saved &&
      saved.promptVersion === TRANSLATION_PROMPT_VERSION &&
      saved.glossaryHash === currentGlossaryHash
    ) {
      const qa = await refreshSavedTranslationQa(jobDir, saved, glossary)
      return {
        status: 'done',
        stage: 'done',
        message: '译文已就绪',
        done: saved.coverage?.segments || 0,
        total: saved.coverage?.segments || 0,
        coverage: saved.coverage || null,
        qa,
      }
    }
    return { status: 'idle', stage: 'idle', message: '还没有开始翻译', done: 0, total: 0 }
  }

  const mapLimit = async (items, limit, fn) => {
    const results = new Array(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await fn(items[index], index)
      }
    })
    await Promise.all(workers)
    return results
  }

  const formulaJobs = new Map()
  const tableTranslationJobs = new Map()
  const formulasFile = 'formulas.json'
  const tableTranslationsFile = 'tables.zh.json'
  const visualModel = process.env.DPR_VISION_MODEL || 'deepseek-flash'

  const assetFileForBlock = (jobDir, block) => {
    const asset = String(block?.asset || '')
    const match = /^assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp|jpe?g|svg))$/i.exec(asset)
    if (!match) return ''
    return path.join(jobDir, 'assets', match[1])
  }

  const prepareVisionImage = async (jobDir, image) => {
    try {
      const executable = await resolvePython()
      const info = await stat(image)
      if (info.size <= 200 * 1024) return image
      const cacheDir = path.join(jobDir, 'vision-cache')
      await mkdir(cacheDir, { recursive: true })
      const output = path.join(cacheDir, path.basename(image, path.extname(image)) + '_1600.webp')
      await new Promise((resolve, reject) => {
        const child = spawnImpl(
          executable,
          [
            path.join(packageRoot, '工具', 'preview-image.py'),
            image,
            '--out',
            cacheDir,
            '--max-side',
            '1600',
            '--format',
            'webp',
            '--quality',
            '90',
            '--max-kb',
            '1',
            '--quiet',
          ],
          { cwd: packageRoot, windowsHide: true },
        )
        let stderr = ''
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || '图像压缩失败'))
        })
      })
      return output
    } catch {
      return image
    }
  }

  const sliceVisionTable = async (jobDir, image, count = 2) => {
    try {
      const executable = await resolvePython()
      const cacheDir = path.join(jobDir, 'vision-cache')
      await mkdir(cacheDir, { recursive: true })
      const output = await new Promise((resolve, reject) => {
        const child = spawnImpl(
          executable,
          [
            path.join(packageRoot, '工具', 'vision-table-slices.py'),
            image,
            '--out',
            cacheDir,
            '--slices',
            String(count),
            '--overlap',
            '0.08',
          ],
          { cwd: packageRoot, windowsHide: true },
        )
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(stderr.trim() || '表格分片失败'))
          else resolve(stdout.trim())
        })
      })
      const payload = JSON.parse(output.split(/\r?\n/).filter(Boolean).pop() || '{}')
      return Array.isArray(payload.slices) ? payload.slices.map(String) : []
    } catch {
      return []
    }
  }

  const formulaStatus = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) return null
    const live = formulaJobs.get(jobId)
    if (live) return live
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    const equations = (doc?.blocks || []).filter((block) => block.type === 'equation')
    const saved = await readJsonIfPresent(path.join(jobDir, formulasFile))
    if (saved?.version === 1 && saved?.promptVersion === FORMULA_PROMPT_VERSION) {
      return {
        status: 'done',
        stage: 'done',
        message: '公式 LaTeX 已就绪',
        done: Object.keys(saved.blocks || {}).length,
        total: equations.length,
        blocks: saved.blocks || {},
        warnings: saved.warnings || [],
      }
    }
    return {
      status: equations.length ? 'idle' : 'empty',
      stage: 'idle',
      message: equations.length ? '还没有转写公式' : '这篇论文没有公式',
      done: 0,
      total: equations.length,
      blocks: {},
      warnings: [],
    }
  }

  const startFormulaTranscription = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const live = formulaJobs.get(jobId)
    if (live?.status === 'running') return live
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    const equations = (doc?.blocks || []).filter((block) => block.type === 'equation')
    if (equations.length === 0) return formulaStatus(jobId)
    const state = {
      status: 'running',
      stage: 'transcribe',
      message: '小的我逐张识别公式…',
      done: 0,
      total: equations.length,
      blocks: {},
      warnings: [],
      cancelRequested: false,
      startedAt: new Date().toISOString(),
    }
    formulaJobs.set(jobId, state)
    void (async () => {
      const blocks = {}
      try {
        await mapLimit(equations, 2, async (block) => {
          if (state.cancelRequested) return
          const image = assetFileForBlock(jobDir, block)
          if (!image) {
            state.warnings.push(block.id + ':missing-asset')
            return
          }
          try {
            const bytes = await readFile(image)
            const assetHash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
            let normalized = null
            let lastError = null
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                const raw = await visionJsonImpl({
                  system: '你是公式 OCR 转写器，只输出 JSON。',
                  user:
                    formulaPrompt(block) +
                    (attempt > 0
                      ? '\n这是第二次检查。请逐符号复核上下标、根号、分式、求和上下限和公式编号，修正上一轮的低置信度结果。'
                      : ''),
                  imagePath: image,
                  model: visualModel,
                  maxTokens: 1600,
                  detail: attempt > 0 ? 'original' : 'high',
                })
                normalized = normalizeFormulaResult(raw)
                if (state.cancelRequested) return
                if (normalized.valid) break
              } catch (error) {
                lastError = error
              }
            }
            normalized ||= {
              latex: '',
              confidence: 0,
              warnings: [lastError?.message || 'vision-empty'],
              valid: false,
            }
            blocks[block.id] = {
              label: block.label || 'Equation',
              page: block.page || 0,
              asset: block.asset || '',
              assetHash,
              model: visualModel,
              promptVersion: FORMULA_PROMPT_VERSION,
              ...normalized,
            }
            if (!normalized.valid) {
              state.warnings.push(block.id + ':low-confidence-or-invalid')
            }
          } catch (error) {
            state.warnings.push(block.id + ':' + (error?.message || String(error)))
          } finally {
            state.done += 1
            state.message = '已识别 ' + state.done + '/' + state.total + ' 个公式'
          }
        })
        if (state.cancelRequested) {
          state.status = 'cancelled'
          state.stage = 'cancelled'
          state.message = '公式识别已取消'
          state.finishedAt = new Date().toISOString()
          return
        }
        const payload = {
          version: 1,
          promptVersion: FORMULA_PROMPT_VERSION,
          model: visualModel,
          createdAt: new Date().toISOString(),
          blocks,
          warnings: [...new Set(state.warnings)],
        }
        await writeFile(path.join(jobDir, formulasFile), JSON.stringify(payload, null, 2), 'utf8')
        state.status = 'done'
        state.stage = 'done'
        state.message = '公式 LaTeX 已就绪'
        state.blocks = blocks
        state.finishedAt = new Date().toISOString()
      } catch (error) {
        state.status = state.cancelRequested ? 'cancelled' : 'failed'
        state.stage = state.status
        state.message = state.cancelRequested ? '公式识别已取消' : error?.message || String(error)
        state.finishedAt = new Date().toISOString()
      }
    })()
    return state
  }

  const saveFormulaBlock = async (jobId, blockId, latex) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const saved = await readJsonIfPresent(path.join(jobDir, formulasFile))
    if (!saved?.blocks?.[blockId]) {
      throw Object.assign(new Error('还没有这个公式的转写记录。'), { statusCode: 404 })
    }
    const normalized = normalizeFormulaResult({ latex, confidence: 1, warnings: [] })
    if (!normalized.valid) {
      throw Object.assign(
        new Error('LaTeX 仍不合格：' + (normalized.warnings.join(',') || 'empty')),
        { statusCode: 400 },
      )
    }
    saved.blocks[blockId] = {
      ...saved.blocks[blockId],
      latex: normalized.latex,
      confidence: 1,
      warnings: [],
      valid: true,
      manual: true,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(path.join(jobDir, formulasFile), JSON.stringify(saved, null, 2), 'utf8')
    return saved.blocks[blockId]
  }

  const tableTranslationStatus = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) return null
    const live = tableTranslationJobs.get(jobId)
    if (live) return live
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    const tables = (doc?.blocks || []).filter((block) => block.type === 'table')
    const saved = await readJsonIfPresent(path.join(jobDir, tableTranslationsFile))
    if (saved?.version === 1 && saved?.promptVersion === TABLE_PROMPT_VERSION) {
      return {
        status: 'done',
        stage: 'done',
        message: '表格译文已就绪',
        done: Object.keys(saved.blocks || {}).length,
        total: tables.length,
        blocks: saved.blocks || {},
        warnings: saved.warnings || [],
      }
    }
    return {
      status: tables.length ? 'idle' : 'empty',
      stage: 'idle',
      message: tables.length ? '还没有生成表格译文' : '这篇论文没有表格',
      done: 0,
      total: tables.length,
      blocks: {},
      warnings: [],
      cancelRequested: false,
    }
  }

  const startTableTranslation = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const live = tableTranslationJobs.get(jobId)
    if (live?.status === 'running') return live
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    const tables = (doc?.blocks || []).filter((block) => block.type === 'table')
    if (tables.length === 0) return tableTranslationStatus(jobId)
    const state = {
      status: 'running',
      stage: 'translate',
      message: '小的我逐张整理表格…',
      done: 0,
      total: tables.length,
      blocks: {},
      warnings: [],
      cancelRequested: false,
      startedAt: new Date().toISOString(),
    }
    tableTranslationJobs.set(jobId, state)
    void (async () => {
      const blocks = {}
      try {
        await mapLimit(tables, 2, async (block) => {
          if (state.cancelRequested) return
          const image = assetFileForBlock(jobDir, block)
          if (!image) {
            state.warnings.push(block.id + ':missing-asset')
            return
          }
          const sourceText = block.tableText || block.text || ''
          const runVision = async (imagePath) => {
            const raw = await visionJsonImpl({
              system: '你是学术表格结构化与翻译引擎，只输出 JSON。',
              user: tablePrompt(block, DEFAULT_TARGET_LANG),
              imagePath,
              model: visualModel,
              maxTokens: 8000,
            })
            return normalizeTableResult(raw, sourceText)
          }
          const runSliceVision = async (imagePath, index, total) => {
            const raw = await visionJsonImpl({
              system: '你是学术表格结构化与翻译引擎，只输出 JSON。',
              user: tableSlicePrompt(block, index, total, DEFAULT_TARGET_LANG),
              imagePath,
              model: visualModel,
              maxTokens: 7000,
              detail: 'original',
            })
            return normalizeTableResult(raw, sourceText)
          }
          try {
            const visionImage = await prepareVisionImage(jobDir, image)
            let normalized = null
            let mode = 'full'
            if (block.rotatedPage) {
              const structuredRows = parseRotatedTableGrid(sourceText)
              if (structuredRows.length) {
                const structured = normalizeTableResult({ rows: structuredRows }, sourceText)
                if (structured.valid) {
                  normalized = structured
                  mode = 'structured'
                }
              }
            }
            if (!normalized?.valid && block.rotatedPage && String(sourceText).includes('\n')) {
              const batches = buildTableTextBatches(sourceText)
              if (batches.length) {
                const textModel = process.env.DPR_TABLE_TEXT_MODEL || 'deepseek-chat'
                const textParts = (
                  await mapLimit(batches, 2, async (batch) => {
                    try {
                      const raw = await chatJsonImpl({
                        system: '你是学术表格文本重建与翻译引擎，只输出 JSON。',
                        user: tableTextPrompt(block, batch, DEFAULT_TARGET_LANG),
                        model: textModel,
                        fetchImpl,
                        maxTokens: 6000,
                      })
                      return normalizeTableResult(
                        raw,
                        [...batch.headerLines, ...batch.bodyLines].join('\n'),
                      )
                    } catch (error) {
                      state.warnings.push(block.id + ':text:' + (error?.message || String(error)))
                      return null
                    }
                  })
                ).filter(Boolean)
                if (textParts.length) {
                  const mergedText = mergeTableSlices(textParts)
                  const mergedTextNormalized = normalizeTableResult(mergedText, sourceText)
                  if (mergedTextNormalized.valid) {
                    normalized = mergedTextNormalized
                    mode = 'text'
                  }
                }
              }
            }
            try {
              if (!normalized?.valid) normalized = await runVision(visionImage)
            } catch (error) {
              state.warnings.push(block.id + ':initial:' + (error?.message || String(error)))
            }
            if (!normalized?.valid) {
              for (const [count, lean] of [[2, false], [4, true], [6, true]]) {
                if (normalized?.valid) break
                const slices = await sliceVisionTable(jobDir, image, count)
                if (slices.length < 2) continue
                const parts = (
                  await mapLimit(slices, 2, async (slice, sliceIndex) => {
                    try {
                      return lean
                        ? await runSliceVision(slice, sliceIndex, slices.length)
                        : await runVision(slice)
                    } catch (error) {
                      state.warnings.push(block.id + ':slice:' + (error?.message || String(error)))
                      return null
                    }
                  })
                ).filter(Boolean)
                if (parts.length > 0) {
                  const merged = mergeTableSlices(parts)
                  const mergedNormalized = normalizeTableResult(merged, sourceText)
                  if (mergedNormalized.valid) {
                    normalized = mergedNormalized
                    mode = 'slices-' + count
                  } else if (!normalized) {
                    normalized = { ...mergedNormalized, warnings: [...mergedNormalized.warnings, ...merged.warnings] }
                  }
                }
              }
            }
            const finalResult = normalized || {
              rows: [],
              warnings: ['vision-empty'],
              valid: false,
            }
            blocks[block.id] = {
              label: block.label || 'Table',
              page: block.page || 0,
              asset: block.asset || '',
              model: visualModel,
              promptVersion: TABLE_PROMPT_VERSION,
              mode,
              ...finalResult,
            }
            if (!finalResult.valid) {
              state.warnings.push(block.id + ':' + (finalResult.warnings.join(',') || 'invalid-table'))
            }
          } catch (error) {
            state.warnings.push(block.id + ':' + (error?.message || String(error)))
          } finally {
            state.done += 1
            state.message = '已整理 ' + state.done + '/' + state.total + ' 个表格'
          }
        })
        if (state.cancelRequested) {
          state.status = 'cancelled'
          state.stage = 'cancelled'
          state.message = '表格整理已取消'
          state.finishedAt = new Date().toISOString()
          return
        }
        const payload = {
          version: 1,
          promptVersion: TABLE_PROMPT_VERSION,
          model: visualModel,
          targetLang: DEFAULT_TARGET_LANG,
          createdAt: new Date().toISOString(),
          blocks,
          warnings: [...new Set(state.warnings)],
        }
        await writeFile(path.join(jobDir, tableTranslationsFile), JSON.stringify(payload, null, 2), 'utf8')
        state.status = 'done'
        state.stage = 'done'
        state.message = '表格译文已就绪'
        state.blocks = blocks
        state.finishedAt = new Date().toISOString()
      } catch (error) {
        state.status = state.cancelRequested ? 'cancelled' : 'failed'
        state.stage = state.status
        state.message = state.cancelRequested ? '表格整理已取消' : error?.message || String(error)
        state.finishedAt = new Date().toISOString()
      }
    })()
    return state
  }

  const startTranslation = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const live = translationJobs.get(jobId)
    if (live && live.status === 'running') return live
    const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
    const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
    if (!doc) throw Object.assign(new Error('mirrordoc.json 不在了。'), { statusCode: 404 })
    const glossary = await readGlossary(jobDir, doc)
    const currentGlossaryHash = glossaryHash(glossary)
    if (
      saved?.promptVersion === TRANSLATION_PROMPT_VERSION &&
      saved?.glossaryHash === currentGlossaryHash &&
      saved?.coverage?.failed === 0
    ) {
      const done = { status: 'done', stage: 'done', message: '译文已就绪', done: saved.coverage.segments, total: saved.coverage.segments, coverage: saved.coverage }
      translationJobs.set(jobId, done)
      return done
    }
    const { units, skipped } = buildTranslationUnits(doc)
    const tasks = flattenTasks(units)
    const state = {
      status: 'running',
      stage: 'prepare',
      message: '小的我先把段落切成对照小段…',
      done: 0,
      total: tasks.length,
      skipped,
      startedAt: new Date().toISOString(),
      warnings: [],
    }
    translationJobs.set(jobId, state)
    void (async () => {
      try {
        const cachePath = path.join(jobDir, translationCacheFile)
        const cache = (await readJsonIfPresent(cachePath)) || {}
        const model = process.env.DPR_TRANSLATION_MODEL || 'deepseek-chat'
        const translations = new Map()
        const missing = []
        for (const task of tasks) {
          const key = translationCacheKey(task.text, {
            targetLang: DEFAULT_TARGET_LANG,
            model,
            promptVersion: TRANSLATION_PROMPT_VERSION,
            glossaryHash: currentGlossaryHash,
          })
          if (typeof cache[key] === 'string' && cache[key].trim()) {
            translations.set(task.taskId, cache[key])
            state.done += 1
          } else {
            missing.push(task)
          }
        }
        state.stage = 'translate'
        state.message = '小的我按小段翻译，并保留引用与数字…'
        const system = buildTranslationPrompt({
          targetLang: DEFAULT_TARGET_LANG,
          glossary: promptGlossary(glossary),
        })
        // One semantic segment per request: prevents a model from shifting
        // neighbouring translations across ids, which is worse than paying a
        // few extra short requests.
        const batches = chunkTasks(missing, { maxTasks: 1, maxChars: 2200 })
        await mapLimit(batches, 3, async (batch) => {
          if (state.cancelRequested) return
          const ids = batch.map((task) => task.taskId)
          const protectedTexts = new Map(
            batch.map((task) => {
              const protectedValue = protectCitations(task.text)
              return [task.taskId, protectedValue]
            }),
          )
          const user = JSON.stringify(
            batch.map((task) => ({ id: task.taskId, text: protectedTexts.get(task.taskId).text })),
          )
          let parsed = null
          let lastError = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const raw = await chatJsonImpl({
                system,
                user,
                model,
                fetchImpl,
                maxTokens: 4000,
              })
              if (state.cancelRequested) return
              parsed = raw && typeof raw === 'object' && !Array.isArray(raw)
                ? new Map(ids.map((id) => [id, raw[id]]))
                : parseTranslationResponse(raw, ids)
              break
            } catch (error) {
              lastError = error
              if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700))
            }
          }
          if (!parsed) {
            state.warnings.push('batch failed: ' + (lastError?.message || String(lastError)))
            return
          }
          for (const task of batch) {
            const rawTarget = parsed.get(task.taskId)
            if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
              state.warnings.push('missing: ' + task.taskId)
              continue
            }
            const restored = restoreCitations(
              rawTarget,
              protectedTexts.get(task.taskId)?.markers || [],
            )
            const target = restored.text
            if (restored.warnings.length) state.warnings.push(task.taskId + ' ' + restored.warnings.join(','))
            const warnings = validateTranslation(task.text, target)
            if (warnings.length) state.warnings.push(task.taskId + ' ' + warnings.join(','))
            translations.set(task.taskId, target.trim())
            cache[translationCacheKey(task.text, {
              targetLang: DEFAULT_TARGET_LANG,
              model,
              promptVersion: TRANSLATION_PROMPT_VERSION,
              glossaryHash: currentGlossaryHash,
            })] = target.trim()
            state.done += 1
          }
          await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8')
          state.message = '已翻译 ' + state.done + '/' + state.total + ' 个小段'
        })
        if (state.cancelRequested) {
          state.status = 'cancelled'
          state.stage = 'cancelled'
          state.message = '翻译已取消；已完成并缓存的段落会保留'
          state.finishedAt = new Date().toISOString()
          return
        }
        state.stage = 'assemble'
        state.message = '小的我把译文按块装回去…'
        const result = assembleTranslations({
          units,
          translations,
          model,
          targetLang: DEFAULT_TARGET_LANG,
          warnings: state.warnings,
        })
        result.glossaryHash = currentGlossaryHash
        result.qa = auditTranslations({
          blocks: result.blocks,
          meta: result.meta,
          glossary,
        })
        result.skippedBlocks = skipped
        await writeFile(path.join(jobDir, translationFile), JSON.stringify(result, null, 2), 'utf8')
        state.status = result.coverage.failed > 0 && result.coverage.translated === 0 ? 'failed' : 'done'
        state.stage = state.status === 'done' ? 'done' : 'failed'
        state.message = state.status === 'done'
          ? '译文完成：' + result.coverage.translated + ' 个小段'
          : '翻译失败，原始段落仍可阅读'
        state.coverage = result.coverage
        state.qa = result.qa
        state.finishedAt = new Date().toISOString()
      } catch (error) {
        state.status = state.cancelRequested ? 'cancelled' : 'failed'
        state.stage = state.status
        state.message = state.cancelRequested ? '翻译已取消' : error?.message || String(error)
        state.error = state.message
        state.finishedAt = new Date().toISOString()
      }
    })()
    return state
  }

  const reviewJobs = new Map()

  const cancelTask = (jobId, kind) => {
    const wanted = String(kind || '')
    const state =
      wanted === 'translation'
        ? translationJobs.get(jobId)
        : wanted === 'review'
          ? reviewJobs.get(jobId)
          : wanted === 'formula'
            ? formulaJobs.get(jobId)
            : wanted === 'table'
              ? tableTranslationJobs.get(jobId)
              : null
    if (!state) throw Object.assign(new Error('找不到这个后台任务'), { statusCode: 404 })
    if (state.status !== 'running') return state
    state.cancelRequested = true
    state.message = '收到取消请求；当前模型请求结束后停止'
    if (wanted === 'formula' || wanted === 'table') {
      state.status = 'cancelled'
      state.stage = 'cancelled'
      state.finishedAt = new Date().toISOString()
    }
    return state
  }

  const translationReviewStatus = async (jobId) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) return null
    const live = reviewJobs.get(jobId)
    if (live) {
      if (live.status === 'running') return live
      return {
        ...live,
        ...(live.review || {}),
        review: live.review,
        done: live.done || live.review?.reviewed || 0,
        total: live.total || live.review?.reviewed || 0,
      }
    }
    const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
    if (!saved) {
      return { status: 'idle', stage: 'idle', message: '还没有译文可复核', done: 0, total: 0 }
    }
    if (saved.review?.promptVersion === REVIEW_PROMPT_VERSION) {
      return { ...saved.review, done: saved.review.reviewed || 0, total: saved.review.reviewed || 0 }
    }
    return {
      status: 'idle',
      stage: 'idle',
      message: '还没有做整篇语义复核',
      done: 0,
      total: saved.coverage?.segments || 0,
    }
  }

  const startTranslationReview = async (jobId, { force = false } = {}) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const live = reviewJobs.get(jobId)
    if (live?.status === 'running') return live
    const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
    if (!saved) throw Object.assign(new Error('还没有生成译文，不能复核。'), { statusCode: 404 })
    if (
      !force &&
      saved.review?.promptVersion === REVIEW_PROMPT_VERSION &&
      saved.review.status !== 'failed'
    ) {
      return translationReviewStatus(jobId)
    }
    const tasks = collectReviewSegments(saved)
    const state = {
      status: 'running',
      stage: 'backtranslate',
      message: '小的我先做回译…',
      done: 0,
      total: tasks.length,
      issues: [],
      warnings: [],
      cancelRequested: false,
      startedAt: new Date().toISOString(),
    }
    reviewJobs.set(jobId, state)
    void (async () => {
      try {
        const model = process.env.DPR_REVIEW_MODEL || 'deepseek-chat'
        const batches = chunkReviewTasks(tasks)
        const issues = []
        for (const [batchIndex, batch] of batches.entries()) {
          if (state.cancelRequested) break
          state.stage = 'backtranslate'
          state.message = '回译 ' + (batchIndex + 1) + '/' + batches.length + ' 组…'
          try {
            const backRaw = await chatJsonImpl({
              system: '你是学术翻译审校器，只输出 JSON。',
              user: buildBackTranslationPrompt(batch),
              model,
              fetchImpl,
              maxTokens: Math.min(6000, 900 + batch.length * 320),
            })
            const back = parseBackTranslations(backRaw, batch.map((task) => task.taskId))
            state.stage = 'review'
            state.message = '语义审校 ' + (batchIndex + 1) + '/' + batches.length + ' 组…'
            const reviewed = await chatJsonImpl({
              system: '你是论文译文审校器，只输出 JSON。',
              user: buildSemanticReviewPrompt(batch, back),
              model,
              fetchImpl,
              maxTokens: Math.min(7000, 1200 + batch.length * 420),
            })
            if (state.cancelRequested) break
            const normalized = normalizeReviewIssues(reviewed, batch, back)
            issues.push(...normalized.issues)
            state.warnings.push(...normalized.warnings)
            const repairTargets = normalized.issues.filter((issue) => !issue.revisedTarget)
            if (repairTargets.length) {
              state.stage = 'repair'
              state.message = '自动修复 ' + (batchIndex + 1) + '/' + batches.length + ' 组…'
              try {
                const repairRaw = await chatJsonImpl({
                  system: '你是学术译文修复器，只输出 JSON。',
                  user: buildIssueRepairPrompt(repairTargets),
                  model,
                  fetchImpl,
                  maxTokens: Math.min(5000, 800 + repairTargets.length * 420),
                })
                applyRepairSuggestions(repairTargets, repairRaw)
              } catch (error) {
                state.warnings.push('repair ' + (batchIndex + 1) + ': ' + (error?.message || String(error)))
              }
            }
          } catch (error) {
            state.warnings.push('batch ' + (batchIndex + 1) + ': ' + (error?.message || String(error)))
          }
          state.done += batch.length
          state.message = '已复核 ' + state.done + '/' + tasks.length + ' 个小段'
        }
        if (state.cancelRequested) {
          state.status = 'cancelled'
          state.stage = 'cancelled'
          state.message = '复核已取消；现有译文没有被改写'
          state.finishedAt = new Date().toISOString()
          return
        }
        const autoIssues = issues.filter((issue) => issue.revisedTarget)
        const appliedResult = applyReviewRevisions(saved, autoIssues)
        const decidedAt = new Date().toISOString()
        for (const issue of autoIssues) {
          issue.decision = 'accepted'
          issue.decidedAt = decidedAt
          issue.automatic = true
        }
        const pending = issues.filter((issue) => !issue.decision || issue.decision === 'pending').length
        const glossary = await readGlossary(jobDir, await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json')))
        saved.qa = auditTranslations({
          blocks: saved.blocks,
          meta: saved.meta,
          glossary,
        })
        saved.review = {
          version: 1,
          promptVersion: REVIEW_PROMPT_VERSION,
          status: pending > 0 ? 'warn' : 'done',
          model,
          reviewed: tasks.length,
          issueCount: issues.length,
          pending,
          accepted: autoIssues.length,
          rejected: 0,
          applied: appliedResult.applied,
          issues: issues.slice(0, 240),
          warnings: [...new Set([...(saved.warnings || []), ...state.warnings])].slice(0, 200),
          updatedAt: new Date().toISOString(),
        }
        await writeFile(path.join(jobDir, translationFile), JSON.stringify(saved, null, 2), 'utf8')
        state.status = 'done'
        state.stage = 'done'
        state.message =
          '复核完成：' +
          tasks.length +
          ' 个小段，发现 ' +
          issues.length +
          ' 条问题，自动修订 ' +
          appliedResult.applied +
          ' 条，另 ' +
          pending +
          ' 条保留现译待追溯'
        state.issues = saved.review.issues
        state.review = saved.review
        state.qa = saved.qa
        state.finishedAt = new Date().toISOString()
      } catch (error) {
        state.status = state.cancelRequested ? 'cancelled' : 'failed'
        state.stage = state.status
        state.message = state.cancelRequested ? '复核已取消' : error?.message || String(error)
        state.finishedAt = new Date().toISOString()
      }
    })()
    return state
  }

  const decideTranslationReview = async (jobId, payload) => {
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) throw Object.assign(new Error('这篇论文的作业目录不在了。'), { statusCode: 404 })
    const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
    if (!saved?.review || !Array.isArray(saved.review.issues)) {
      throw Object.assign(new Error('还没有可处理的复核结果。'), { statusCode: 404 })
    }
    const taskId = String(payload?.taskId || '')
    const action = String(payload?.action || '')
    if (!taskId || !['accept', 'reject'].includes(action)) {
      throw Object.assign(new Error('复核决定需要 taskId 与 accept/reject'), { statusCode: 400 })
    }
    const issue = saved.review.issues.find((item) => item.taskId === taskId)
    if (!issue) throw Object.assign(new Error('找不到这条复核问题。'), { statusCode: 404 })
    if (issue.decision && issue.decision !== 'pending') {
      throw Object.assign(new Error('这条复核问题已经处理过了。'), { statusCode: 409 })
    }
    if (action === 'accept' && issue.revisedTarget) {
      const result = applyReviewRevisions(saved, [{ ...issue, decision: 'accepted' }])
      if (result.applied !== 1) {
        throw Object.assign(new Error('修订未通过引用/数字校验，不能采用。'), { statusCode: 400 })
      }
    }
    issue.decision = action === 'accept' ? 'accepted' : 'rejected'
    issue.decidedAt = new Date().toISOString()
    const issues = saved.review.issues
    saved.review.pending = issues.filter((item) => !item.decision || item.decision === 'pending').length
    saved.review.accepted = issues.filter((item) => item.decision === 'accepted').length
    saved.review.rejected = issues.filter((item) => item.decision === 'rejected').length
    saved.review.applied = issues.filter(
      (item) => item.decision === 'accepted' && item.revisedTarget,
    ).length
    saved.review.status = saved.review.pending > 0 ? 'warn' : 'done'
    saved.review.updatedAt = new Date().toISOString()
    const glossary = await readGlossary(jobDir, await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json')))
    saved.qa = auditTranslations({
      blocks: saved.blocks,
      meta: saved.meta,
      glossary,
    })
    await writeFile(path.join(jobDir, translationFile), JSON.stringify(saved, null, 2), 'utf8')
    const live = reviewJobs.get(jobId)
    if (live) {
      live.review = saved.review
      live.issues = saved.review.issues
      live.qa = saved.qa
      live.status = saved.review.status
      live.stage = 'done'
      live.message =
        '复核问题：待处理 ' +
        saved.review.pending +
        '，已采用 ' +
        saved.review.applied +
        '，已保留 ' +
        saved.review.rejected
    }
    return {
      ok: true,
      issue,
      review: saved.review,
      qa: saved.qa,
    }
  }

  const importPdf = async (req, res) => {
    if (req.method !== 'POST') {
      sendError(res, 405, '只接受 POST 上传')
      return
    }
    const body = await readBody(req, MAX_PDF_BYTES, 'PDF')
    if (!isPdfBuffer(body)) {
      sendError(res, 415, '这份文件不是 PDF，陛下换一份吧。')
      return
    }
    const jobId = randomUUID()
    const jobDir = path.join(jobsRoot, jobId)
    await mkdir(jobDir, { recursive: true })
    const pdfPath = path.join(jobDir, 'original.pdf')
    await writeFile(pdfPath, body)
    const job = {
      id: jobId,
      dir: jobDir,
      pdfPath,
      kind: 'pdf-import',
      pipeline: 'pdf',
      originalName: cleanOriginalName(req.headers['x-dpr-filename']),
      status: 'running',
      stage: 'queued',
      message: '小的我把 PDF 收下了，排在抄写队列里。',
      startedAt: new Date().toISOString(),
    }
    jobs.set(jobId, job)
    void runJob(job)
    sendJson(res, 201, {
      jobId,
      statusUrl: API_PREFIX + 'jobs/' + jobId,
      message: job.message,
    })
  }

  const citationOpenPage = async (req, res) => {
    if (req.method !== 'GET') {
      sendError(res, 405, '只接受 GET')
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const jobId = String(url.searchParams.get('jobId') || '')
    const blockId = String(url.searchParams.get('blockId') || '')
    if (!JOB_ID_RE.test(jobId) || !/^[A-Za-z0-9_-]{1,80}$/.test(blockId)) {
      sendError(res, 400, '回跳参数不合法')
      return
    }
    const jobDir = await jobDirFor(jobId)
    if (!jobDir) {
      sendError(res, 404, '这篇论文的作业目录不在了。')
      return
    }
    const payload = JSON.stringify({ type: 'doraemon-paper-reader/open', jobId, blockId }).replace(
      /</g,
      '\\u003c',
    )
    const html = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>正在回到论文原段</title>',
      '<style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#333}</style></head>',
      '<body><p>正在回到论文原段…</p>',
      '<script>',
      'const payload=' + payload + ';',
      'try{if(window.parent!==window)window.parent.postMessage(payload,"*")}catch(e){}',
      'try{if(window.opener)window.opener.postMessage(payload,"*")}catch(e){}',
      'try{const channel=new BroadcastChannel("doraemon-paper-reader");channel.postMessage(payload);setTimeout(()=>channel.close(),100)}catch(e){}',
      'document.body.innerHTML="<p>已请求打开阅读页；若没有跳转，请回到对话再点一次。</p>";',
      '</script></body></html>',
    ].join('')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(html, 'utf8')),
    })
    res.end(html)
  }

  const handler = async (req, res) => {
    const route = routeRequest(req.url)
    if (route === null) {
      sendError(res, 404, 'Not found')
      return
    }
    try {
      if (route.type === 'citation-open') {
        await citationOpenPage(req, res)
        return
      }
      if (route.type === 'import') {
        await importPdf(req, res)
        return
      }
      if (route.type === 'lookup-resolve' || route.type === 'lookup-fetch') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readBody(req, MAX_LOOKUP_BYTES, '查询')
        let fields
        try {
          fields = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '查询内容不是合法 JSON')
          return
        }
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          sendError(res, 400, '查询内容必须是一个对象')
          return
        }
        const resolution = await resolveLookup(fields, {
          fetchImpl,
          existing: existingLibraryJob,
        })
        if (route.type === 'lookup-resolve' || resolution.kind !== 'exact') {
          sendJson(res, 200, resolution)
          return
        }
        const job = createLookupJob(resolution, fields)
        sendJson(res, 201, {
          ...publicJob(job),
          statusUrl: API_PREFIX + 'jobs/' + job.id,
        })
        return
      }
      if (
        route.type === 'citation-resolve' ||
        route.type === 'citation-analyze' ||
        route.type === 'citation-promote'
      ) {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readBody(req, MAX_CITATION_BYTES, '引用请求')
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '引用请求不是合法 JSON')
          return
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          sendError(res, 400, '引用请求必须是一个对象')
          return
        }
        if (route.type === 'citation-resolve') {
          sendJson(res, 200, await citationResolve(payload))
          return
        }
        if (route.type === 'citation-analyze') {
          sendJson(res, 200, await citationAnalyze(payload))
          return
        }
        sendJson(res, 200, await promotePreviewJob(String(payload.jobId || '')))
        return
      }
      if (route.type === 'citation-index') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        const index = await citationIndexFor(route.jobId)
        if (!index) {
          sendError(res, 404, '这篇论文的引用索引还没有准备好。')
          return
        }
        sendJson(res, 200, index)
        return
      }
      if (route.type === 'formulas') {
        if (req.method === 'GET') {
          const status = await formulaStatus(route.jobId)
          if (!status) {
            sendError(res, 404, '这篇论文的作业目录不在了。')
            return
          }
          sendJson(res, 200, status)
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 202, await startFormulaTranscription(route.jobId))
          return
        }
        sendError(res, 405, '只接受 GET/POST')
        return
      }
      if (route.type === 'formula-render') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        let warning = ''
        try {
          await renderFormulas(jobDir)
        } catch (error) {
          // SVG 只是 KaTeX 与原图之后的第三层排版回退；渲染器不可用时不能让公式区变红。
          warning = error?.message || String(error)
        }
        let renders = {}
        try {
          renders = JSON.parse(
            await readFile(path.join(jobDir, 'assets', 'formula-renders.json'), 'utf8'),
          )
        } catch {
          renders = {}
        }
        sendJson(res, 200, warning ? { renders, warning } : { renders })
        return
      }
      if (route.type === 'versions') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        const baseDoc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
        if (!baseDoc) {
          sendError(res, 404, '这篇论文没有 MirrorDoc。')
          return
        }
        const title = String(baseDoc?.meta?.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
        const doi = String(baseDoc?.meta?.doi || '').toLowerCase()
        const versions = []
        let entries = []
        try {
          entries = await readdir(jobsRoot, { withFileTypes: true })
        } catch {
          entries = []
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue
          const dir = path.join(jobsRoot, entry.name)
          const doc = await readJsonIfPresent(path.join(dir, 'mirrordoc.json'))
          if (!doc) continue
          const otherTitle = String(doc?.meta?.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
          const otherDoi = String(doc?.meta?.doi || '').toLowerCase()
          if ((doi && otherDoi && doi === otherDoi) || (title && otherTitle === title)) {
            const summary = await readJsonIfPresent(path.join(dir, 'paper-summary.json'))
            versions.push({
              jobId: entry.name,
              title: doc?.meta?.title || summary?.title || '',
              version: doc?.version?.kind || summary?.version?.kind || 'unknown',
              createdAt: summary?.generatedAt || doc?.meta?.generatedAt || '',
            })
          }
        }
        versions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        sendJson(res, 200, { versions })
        return
      }
      if (route.type === 'formula-block') {
        if (req.method !== 'PUT') {
          sendError(res, 405, '只接受 PUT')
          return
        }
        const body = await readBody(req, 64 * 1024, '公式 LaTeX')
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '公式内容不是合法 JSON')
          return
        }
        const block = await saveFormulaBlock(route.jobId, route.blockId, String(payload?.latex || ''))
        sendJson(res, 200, { ok: true, block })
        return
      }
      if (route.type === 'tables') {
        if (req.method === 'GET') {
          const status = await tableTranslationStatus(route.jobId)
          if (!status) {
            sendError(res, 404, '这篇论文的作业目录不在了。')
            return
          }
          sendJson(res, 200, status)
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 202, await startTableTranslation(route.jobId))
          return
        }
        sendError(res, 405, '只接受 GET/POST')
        return
      }
      if (route.type === 'translation') {
        if (req.method !== 'POST' && req.method !== 'GET') {
          sendError(res, 405, '只接受 GET/POST')
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 202, await startTranslation(route.jobId))
          return
        }
        const status = await translationStatus(route.jobId)
        if (!status) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        sendJson(res, 200, status)
        return
      }
      if (route.type === 'translation-review') {
        if (req.method === 'GET') {
          const status = await translationReviewStatus(route.jobId)
          if (!status) {
            sendError(res, 404, '这篇论文的作业目录不在了。')
            return
          }
          sendJson(res, 200, status)
          return
        }
        if (req.method === 'POST') {
          const force = new URL(req.url || '/', 'http://localhost').searchParams.get('force') === '1'
          sendJson(res, 202, await startTranslationReview(route.jobId, { force }))
          return
        }
        sendError(res, 405, '只接受 GET/POST')
        return
      }
      if (route.type === 'translation-review-decision') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readBody(req, MAX_CITATION_BYTES, '复核决定')
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '复核决定不是合法 JSON')
          return
        }
        sendJson(res, 200, await decideTranslationReview(route.jobId, payload))
        return
      }
      if (route.type === 'cancel-task') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, 16 * 1024, '取消任务请求')
        const kind = String(body.kind || '')
        if (!['translation', 'review', 'formula', 'table'].includes(kind)) {
          sendError(res, 400, '可取消任务只接受 translation/review/formula/table')
          return
        }
        sendJson(res, 200, { ok: true, state: cancelTask(route.jobId, kind) })
        return
      }
      if (route.type === 'version') {
        if (req.method !== 'PUT') {
          sendError(res, 405, '只接受 PUT')
          return
        }
        const body = await readBody(req, 16 * 1024, '版本信息')
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '版本信息不是合法 JSON')
          return
        }
        sendJson(res, 200, { ok: true, version: await updateJobVersion(route.jobId, payload) })
        return
      }
      if (route.type === 'glossary') {
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
        if (!doc) {
          sendError(res, 404, 'mirrordoc.json 不在了。')
          return
        }
        if (req.method === 'GET') {
          const entries = await readGlossary(jobDir, doc)
          sendJson(res, 200, { entries, hash: glossaryHash(entries) })
          return
        }
        if (req.method === 'PUT') {
          const body = await readBody(req, MAX_CITATION_BYTES, '术语表')
          let payload
          try {
            payload = JSON.parse(body.toString('utf8'))
          } catch {
            sendError(res, 400, '术语表不是合法 JSON')
            return
          }
          let entries
          try {
            entries = normalizeGlossary(payload?.entries)
          } catch (error) {
            sendError(res, 400, error.message)
            return
          }
          await writeFile(
            path.join(jobDir, glossaryFile),
            JSON.stringify({ version: 7, entries }, null, 2),
            'utf8',
          )
          sendJson(res, 200, { entries, hash: glossaryHash(entries) })
          return
        }
        sendError(res, 405, '只接受 GET/PUT')
        return
      }
      if (route.type === 'term-lookup') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, 64 * 1024, '查词请求')
        sendJson(res, 200, await lookupTerm(route.jobId, body))
        return
      }
      if (route.type === 'translations-file') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        const saved = await readJsonIfPresent(path.join(jobDir, translationFile))
        if (!saved) {
          sendError(res, 404, '还没有生成译文。')
          return
        }
        const doc = await readJsonIfPresent(path.join(jobDir, 'mirrordoc.json'))
        if (doc) {
          const glossary = await readGlossary(jobDir, doc)
          await refreshSavedTranslationQa(jobDir, saved, glossary)
        }
        sendJson(res, 200, saved)
        return
      }
      if (route.type === 'annotation-save') {
        if (!annotations) {
          sendError(res, 503, '批注服务还没起来，陛下稍后再试。')
          return
        }
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readBody(req, MAX_ANNOTATION_BYTES, '批注包')
        let packet
        try {
          packet = JSON.parse(body.toString('utf8'))
        } catch {
          sendError(res, 400, '批注内容不是合法 JSON')
          return
        }
        const saved = await annotations.save(packet)
        sendJson(res, 201, saved)
        return
      }
      if (route.type === 'annotation-read') {
        if (!annotations) {
          sendError(res, 503, '批注服务还没起来，陛下稍后再试。')
          return
        }
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        const record = await annotations.read(route.batchId)
        sendJson(res, 200, {
          batchId: record.batchId,
          createdAt: record.createdAt,
          packet: record.packet,
        })
        return
      }
      if (route.type === 'maintenance') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        sendJson(res, 200, await maintenanceSnapshot())
        return
      }
      if (route.type === 'maintenance-python') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        if (!managedPythonRuntime) {
          sendJson(res, 200, { status: 'external', executable: python, envRoot: '' })
          return
        }
        const ready = await managedPythonRuntime.ensure()
        sendJson(res, 200, ready)
        return
      }
      if (route.type === 'maintenance-cleanup') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, 32 * 1024, '缓存清理请求')
        sendJson(res, 200, await cleanupCaches(body.scopes))
        return
      }
      if (route.type === 'library') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        sendJson(res, 200, { papers: await listLibrary() })
        return
      }
      if (route.type === 'compare-digests') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '对照请求')
        const digests = await compareDigests(body.jobIds)
        const citing =
          body.citing && body.citing.jobId && body.citing.blockId
            ? await resolveCiting(
                digests.map((digest) => digest.jobId),
                body.citing,
              )
            : null
        sendJson(res, 200, { digests, citing })
        return
      }
      if (route.type === 'compare-table') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '对照请求')
        const digests = await compareDigests(body.jobIds)
        const key = compareKey({ jobIds: digests.map((digest) => digest.jobId), mode: 'survey' })
        const cached = await readCompareCache(key)
        if (cached?.table) {
          sendJson(res, 200, { table: cached.table, digests, cached: true, savedAt: cached.savedAt })
          return
        }
        const prompt = buildSurveyPrompt({ digests })
        const raw = await chatJsonImpl({
          system: prompt.system,
          user: prompt.user,
          maxTokens: prompt.maxTokens,
        })
        const table = normalizeComparisonTable(raw, digests)
        await writeCompareCache(key, {
          mode: 'survey',
          jobIds: digests.map((digest) => digest.jobId),
          table,
        })
        sendJson(res, 200, { table, digests, cached: false })
        return
      }
      if (route.type === 'compare-citation') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '对照请求')
        const citingJobId = String(body.citingJobId || '')
        const citedJobId = String(body.citedJobId || '')
        if (!citingJobId || !citedJobId || citingJobId === citedJobId) {
          throw Object.assign(new Error('引用对照需要引用方与被引方两个不同的 jobId'), { statusCode: 400 })
        }
        const digests = await compareDigests([citingJobId, citedJobId])
        const citing = await resolveCiting([citingJobId, citedJobId], {
          jobId: citingJobId,
          blockId: body.blockId,
          number: body.number,
          title: body.title,
        })
        const key = compareKey({
          jobIds: digests.map((digest) => digest.jobId),
          mode: 'citation',
          citing,
        })
        const cached = await readCompareCache(key)
        if (cached?.analysis) {
          sendJson(res, 200, {
            analysis: cached.analysis,
            citing: cached.citing || citing,
            digests,
            cached: true,
            savedAt: cached.savedAt,
          })
          return
        }
        const prompt = buildCompareCitationPrompt({ digests, citing })
        const raw = await chatJsonImpl({
          system: prompt.system,
          user: prompt.user,
          maxTokens: prompt.maxTokens,
        })
        const analysis = normalizeCitationVerdict(raw, { digests, citingJobId })
        await writeCompareCache(key, {
          mode: 'citation',
          jobIds: digests.map((digest) => digest.jobId),
          citing,
          analysis,
        })
        sendJson(res, 200, { analysis, citing, digests, cached: false })
        return
      }
      if (route.type === 'compare-packet') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '对照请求')
        const mode = body.mode === 'citation' ? 'citation' : 'survey'
        const digests = await compareDigests(body.jobIds)
        const ids = digests.map((digest) => digest.jobId)
        let citing = null
        if (mode === 'citation') citing = await resolveCiting(ids, body.citing)
        let table = null
        if (mode === 'survey') {
          const cached = await readCompareCache(compareKey({ jobIds: ids, mode: 'survey' }))
          table = cached?.table || null
        }
        const message = buildCompareMessage({
          mode,
          digests,
          citing,
          question: body.question,
          table,
          annotations: body.annotations,
        })
        sendJson(res, 200, {
          message,
          mode,
          jobIds: ids,
          titles: digests.map((digest) => digest.title),
          citing,
        })
        return
      }
      if (route.type === 'compare-ask') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '对照提问')
        const mode = body.mode === 'citation' ? 'citation' : 'survey'
        const question = String(body.question || '').trim()
        if (!question) {
          throw Object.assign(new Error('对照工作台需要一个问题'), { statusCode: 400 })
        }
        const digests = await compareDigests(body.jobIds)
        const ids = digests.map((digest) => digest.jobId)
        let citing = null
        if (mode === 'citation') citing = await resolveCiting(ids, body.citing)
        const prompt = buildCompareChatPrompt({
          mode,
          digests,
          citing,
          annotations: body.annotations,
          question,
          history: body.history,
        })
        let answer
        try {
          answer = await chatTextImpl({
            system: prompt.system,
            user: prompt.user,
            maxTokens: prompt.maxTokens,
          })
        } catch (error) {
          if (error?.code === 'NO_API_KEY') {
            throw Object.assign(new Error(error.message), { statusCode: 503 })
          }
          throw error
        }
        sendJson(res, 200, {
          answer: String(answer || '').trim(),
          mode,
          jobIds: ids,
          at: new Date().toISOString(),
        })
        return
      }
      if (route.type === 'compare-chart') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '数据图请求')
        const digests = await compareDigests(body.jobIds)
        const prompt = buildChartPrompt({
          digests,
          table: body.table || null,
          question: body.question || '请从对照表里选一组有原文依据的数字画图',
        })
        const raw = await chatJsonImpl({
          system: prompt.system,
          user: prompt.user,
          maxTokens: prompt.maxTokens,
        })
        const chart = normalizeChartSpec(raw, { digests, table: body.table || null })
        sendJson(res, 200, { chart, digests })
        return
      }
      if (route.type === 'compare-concept') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '概念图请求')
        const digests = await compareDigests(body.jobIds)
        const prompt = buildConceptPrompt({
          digests,
          question: body.question || '请把这些论文的论证结构画成一张可核对的概念图',
        })
        let raw
        try {
          raw = await chatJsonImpl({
            system: prompt.system,
            user: prompt.user,
            maxTokens: prompt.maxTokens,
          })
        } catch (error) {
          if (error?.code === 'NO_API_KEY') {
            throw Object.assign(new Error(error.message), { statusCode: 503 })
          }
          throw error
        }
        const concept = normalizeConceptSpec(raw, { digests })
        sendJson(res, 200, { concept, digests })
        return
      }
      if (route.type === 'compare-version-diff') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '版本对照请求')
        const leftJobId = String(body.leftJobId || '')
        const rightJobId = String(body.rightJobId || '')
        if (!JOB_ID_RE.test(leftJobId) || !JOB_ID_RE.test(rightJobId) || leftJobId === rightJobId) {
          throw Object.assign(new Error('版本对照需要两个不同的作业'), { statusCode: 400 })
        }
        const leftDir = await jobDirFor(leftJobId)
        const rightDir = await jobDirFor(rightJobId)
        if (!leftDir || !rightDir) {
          sendError(res, 404, '版本作业目录不在了。')
          return
        }
        const leftDoc = await readJsonIfPresent(path.join(leftDir, 'mirrordoc.json'))
        const rightDoc = await readJsonIfPresent(path.join(rightDir, 'mirrordoc.json'))
        if (!leftDoc || !rightDoc) {
          sendError(res, 404, '版本缺少 MirrorDoc。')
          return
        }
        const diff = buildVersionDiff(leftDoc, rightDoc)
        diff.left.jobId = leftJobId
        diff.right.jobId = rightJobId
        sendJson(res, 200, diff)
        return
      }
      if (route.type === 'compare-archive') {
        if (req.method !== 'POST') {
          sendError(res, 405, '只接受 POST')
          return
        }
        const body = await readJsonBody(req, MAX_COMPARE_BYTES, '归档内容')
        const jobIds = Array.isArray(body.jobIds) ? body.jobIds.map(String).filter((id) => JOB_ID_RE.test(id)) : []
        if (jobIds.length < 2) {
          throw Object.assign(new Error('归档至少需要 2 篇论文'), { statusCode: 400 })
        }
        const id =
          new Date().toISOString().replace(/[:.]/g, '-') +
          '-' +
          createHash('sha1')
            .update(jobIds.join(',') + '|' + String(body.report || '').slice(0, 500))
            .digest('hex')
            .slice(0, 8)
        const record = {
          version: 1,
          id,
          createdAt: new Date().toISOString(),
          mode: body.mode === 'citation' ? 'citation' : body.mode === 'version' ? 'version' : 'survey',
          jobIds,
          titles: Array.isArray(body.titles) ? body.titles.map(String).slice(0, 3) : [],
          report: String(body.report || '').slice(0, 512 * 1024),
          table: body.table || null,
          citation: body.citation || null,
          annotations: Array.isArray(body.annotations) ? body.annotations.slice(0, 50) : [],
          messages: Array.isArray(body.messages) ? body.messages.slice(-40) : [],
        }
        await mkdir(compareArchivesRoot, { recursive: true })
        await writeFile(path.join(compareArchivesRoot, id + '.json'), JSON.stringify(record, null, 2), 'utf8')
        sendJson(res, 201, { ok: true, id, createdAt: record.createdAt })
        return
      }
      if (route.type === 'compare-archives') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        let files = []
        try {
          files = await readdir(compareArchivesRoot)
        } catch {
          files = []
        }
        const archives = []
        for (const file of files.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 20)) {
          try {
            const record = JSON.parse(await readFile(path.join(compareArchivesRoot, file), 'utf8'))
            archives.push({
              id: record.id || file.replace(/\.json$/, ''),
              createdAt: record.createdAt || '',
              mode: record.mode || 'survey',
              jobIds: Array.isArray(record.jobIds) ? record.jobIds : [],
              titles: Array.isArray(record.titles) ? record.titles : [],
            })
          } catch {
            // 损坏的归档不让列表失败。
          }
        }
        sendJson(res, 200, { archives })
        return
      }
      if (route.type === 'annotations') {
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这篇论文的作业目录不在了。')
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, await readAnnotations(jobDir, route.jobId))
          return
        }
        if (req.method === 'PUT') {
          const body = await readBody(req, maxSavedAnnotationsBytes, '批注存档')
          let payload
          try {
            payload = JSON.parse(body.toString('utf8'))
          } catch {
            sendError(res, 400, '批注存档不是合法 JSON')
            return
          }
          const saved = await writeAnnotations(jobDir, route.jobId, payload)
          sendJson(res, 200, { ok: true, jobId: saved.jobId, updatedAt: saved.updatedAt, count: saved.items.length })
          return
        }
        sendError(res, 405, '只接受 GET/PUT')
        return
      }
      if (route.type === 'status') {
        if (req.method !== 'GET') {
          sendError(res, 405, '只接受 GET')
          return
        }
        const job = jobs.get(route.jobId)
        if (job) {
          sendJson(res, 200, publicJob(job))
          return
        }
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, '这个抄写任务已经不在内存里了，陛下重新选一次 PDF 吧。')
          return
        }
        sendJson(res, 200, await publicJobFromDisk(route.jobId, jobDir))
        return
      }
      if (route.type === 'file' || route.type === 'asset') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, '只接受 GET/HEAD')
          return
        }
        const jobDir = await jobDirFor(route.jobId)
        if (!jobDir) {
          sendError(res, 404, 'Job not found')
          return
        }
        const file = safeJobFile(jobDir, route)
        if (!file) {
          sendError(res, 404, 'Not found')
          return
        }
        const payload = await readFile(file)
        res.writeHead(200, {
          'Content-Type': contentTypeFor(file),
          'Cache-Control': 'no-cache',
          'Content-Length': String(payload.length),
        })
        res.end(req.method === 'HEAD' ? undefined : payload)
        return
      }
      sendError(res, 404, 'Not found')
    } catch (error) {
      sendError(res, error?.statusCode ?? 500, error?.message || '内部错误')
    }
  }

  return {
    handler,
    dispose() {
      for (const child of children) {
        try {
          child.kill()
        } catch {
          // 已退出。
        }
      }
      children.clear()
      jobs.clear()
    },
    jobs,
  }
}

/**
 * 默认数据根目录：$DSH_HOME/doraemon-paper-reader。
 * @returns {string} 绝对路径。
 */
export function defaultDataRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'doraemon-paper-reader')
}
