// dsh-doraemon-paper-reader —— 宿主半区（Cordis 插件）。
//
// 现在做四件事：
//   1. 静态资源路由 `/doraemon-paper-reader/assets/*`：把包里 assets/ 下的插画发给浏览器
//      （浏览器半区不内联 base64，也不引外部 CDN；纯逻辑在 src/assets.js，L0 有覆盖）；
//   2. PDF 导入/后台抄写 API：`/doraemon-paper-reader/api/*`（上传、任务状态、产物）；
//   3. 批注批次 API + `doraemon_read_annotations` 工具：用户消息只放「批注 N」摘要，
//      完整原文/上下文包落盘后由模型按批次号取回（纯逻辑在 src/annotations.js）；
//   4. 加载日志：让 `dsh dev` 的启动输出能一眼看出这一半起来了。
//
// 约定：本包自包含，不依赖任何第三方插件；官方运行时服务通过 ctx 注入获取。
// 论文路由（MirrorDoc 等）在后续提交里逐个加。

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROUTE_PREFIX, etagFor, methodAllowed, mimeFor, resolveAssetPath } from './assets.js'
import { createAnnotationBatchStore, createReadAnnotationsTool } from './annotations.js'
import { createReadPapersTool } from './compare.js'
import { createPaperDigestReader } from './digest.js'
import { API_ROUTE_PREFIX, createPaperApi, defaultDataRoot } from './papers.js'

export const name = 'dsh-doraemon-paper-reader'

/** 包内 assets/ 目录的绝对路径（本模块所在目录的上一级）。 */
const ASSETS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const VENDOR_ROOT = path.join(ASSETS_ROOT, 'vendor')
/** 包根目录（用于定位随包发布的 Python 转换脚本）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_ROUTE_PREFIX = '/doraemon-paper-reader/vendor'
const VENDOR_FILE_RE = /^katex\/(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[A-Za-z0-9-]+\.woff2)$/

/**
 * 应答一次资源请求：命中就发文件（带 ETag 与 304），否则 404。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 响应写完即结束。
 */
async function serveAsset(req, res) {
  if (!methodAllowed(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  const file = resolveAssetPath(ASSETS_ROOT, req.url)
  if (file === null) {
    res.writeHead(404)
    res.end()
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!info.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  const etag = etagFor(info)
  const headers = {
    'Content-Type': mimeFor(file),
    'Content-Length': String(info.size),
    ETag: etag,
    // 开发期要求「改了就能看到」：允许缓存，但每次都回来验一次 ETag
    'Cache-Control': 'no-cache',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  const body = await readFile(file)
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * 只服务随包的 KaTeX 静态文件；白名单固定，避免把任意文件暴露出去。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 响应写完即结束。
 */
async function serveVendor(req, res) {
  if (!methodAllowed(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!pathname.startsWith(VENDOR_ROUTE_PREFIX + '/')) {
    res.writeHead(404)
    res.end()
    return
  }
  const relative = pathname.slice(VENDOR_ROUTE_PREFIX.length + 1)
  if (!VENDOR_FILE_RE.test(relative)) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = path.resolve(VENDOR_ROOT, relative)
  if (!file.startsWith(path.resolve(VENDOR_ROOT) + path.sep)) {
    res.writeHead(404)
    res.end()
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!info.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  const type = file.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'font/woff2'
  const etag = etagFor(info)
  const headers = {
    'Content-Type': type,
    'Content-Length': String(info.size),
    ETag: etag,
    'Cache-Control': 'no-cache',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  const body = await readFile(file)
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : body)
}

export function apply(ctx) {
  const dataRoot = defaultDataRoot()
  const annotations = createAnnotationBatchStore({ dataRoot })
  const digestReader = createPaperDigestReader({ jobsRoot: path.join(dataRoot, 'jobs') })

  console.log(
    '[doraemon-paper-reader] host half loaded (v0.1.0) — assets + PDF/compare API + read_annotations/read_papers tools',
  )

  // 模型取回完整批注包的工具。用户消息里只放摘要与批次号；
  // 工具结果卡片只展示紧凑摘要，完整 JSON 仍会按 output.render 进入模型上下文。
  ctx.inject(['tools'], (scoped) => {
    try {
      console.log('[doraemon-paper-reader] tools service injected; registering doraemon_read_annotations')
      scoped.effect(
        () => scoped.tools.register(createReadAnnotationsTool({ store: annotations })),
        'doraemon-paper-reader: read annotations tool',
      )
      scoped.effect(
        () => scoped.tools.register(createReadPapersTool({ readDigests: digestReader.readDigests })),
        'doraemon-paper-reader: read papers tool',
      )
      console.log('[doraemon-paper-reader] doraemon_read_annotations / doraemon_read_papers registration installed')
    } catch (error) {
      console.error('[doraemon-paper-reader] tool registration failed:', error)
    }
  })

  // webServer 是可选的（headless 没有它）：用 ctx.inject 而不是 inject 数组，
  // 这样插件在哪儿都算"起来了"，只是没路由可挂。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: serveAsset }),
      'doraemon-paper-reader: assets route',
    )
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: VENDOR_ROUTE_PREFIX, handler: serveVendor }),
      'doraemon-paper-reader: vendor route',
    )
    scoped.effect(
      () => {
        const api = createPaperApi({
          packageRoot: PACKAGE_ROOT,
          dataRoot,
          annotations,
          digestReader,
        })
        const disposeRoute = scoped.webServer.register({
          kind: 'prefix',
          path: API_ROUTE_PREFIX,
          handler: api.handler,
        })
        return () => {
          disposeRoute()
          api.dispose()
        }
      },
      'doraemon-paper-reader: PDF import API',
    )
  })
}
