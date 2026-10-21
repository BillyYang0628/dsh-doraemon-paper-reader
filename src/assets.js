// 静态资源路由的纯逻辑（L0 可测的那部分）。
//
// 浏览器半区的插画不能内联进 client.js（5 MB 源图 → base64 会撑爆），也不该走
// 「随手引一个公共 CDN」。做法是宿主半区注册自己的具名路由（AGENTS.md §2.3 预留的
// `/doraemon-paper-reader/*`），把包里 `assets/` 目录下的文件按名字发出去。
//
// 这里只放不依赖 ctx 的纯函数：请求路径 → 磁盘路径（含穿越栅栏）、扩展名 → MIME、
// 方法白名单、ETag。路由本体在 src/index.js。

import path from 'node:path'

/** 本插件的路由前缀（AGENTS.md §2.3：公共命名必须带我们的前缀）。 */
export const ROUTE_PREFIX = '/doraemon-paper-reader'

/** 允许发出去的资源类型：只服务界面插画用得到的几种。 */
const MIME_BY_EXTENSION = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/**
 * 扩展名 → MIME。
 * @param {string} file - 文件名或路径。
 * @returns {string|undefined} 允许的类型，未知扩展名返回 undefined。
 */
export function mimeFor(file) {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()]
}

/**
 * 请求方法是否可服务：只有 GET / HEAD（与宿主静态服务器的口径一致）。
 * @param {string|undefined} method - HTTP 方法。
 * @returns {boolean} 是否允许。
 */
export function methodAllowed(method) {
  return method === 'GET' || method === 'HEAD'
}

/**
 * 把一次请求的路径解析成 `assets/` 下的磁盘路径。
 *
 * 拒绝规则（少一条就是目录穿越洞）：
 * - 不在路由前缀下；前缀之后不是 `assets/`；扩展名不在白名单；
 * - 解码后出现 `..` 段、绝对路径、盘符、反斜杠；
 * - 规范化之后落到了 assets 根之外。
 * @param {string} assetsRoot - assets 目录的绝对路径。
 * @param {string} requestUrl - 原始请求 URL（`req.url`）。
 * @returns {string|null} 绝对磁盘路径；拒绝时返回 null。
 */
export function resolveAssetPath(assetsRoot, requestUrl) {
  const pathname = (requestUrl ?? '').split('?')[0].split('#')[0]
  if (!pathname.startsWith(ROUTE_PREFIX + '/')) return null
  let relative
  try {
    relative = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length + 1))
  } catch {
    return null
  }
  if (!relative.startsWith('assets/')) return null
  const inner = relative.slice('assets/'.length)
  if (inner.length === 0) return null
  if (inner.includes('\\') || inner.includes('\0')) return null
  const segments = inner.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  if (!mimeFor(inner)) return null
  const root = path.resolve(assetsRoot)
  const target = path.resolve(root, inner)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/**
 * 由文件尺寸与修改时间算 ETag（不读文件内容，够用且便宜）。
 * @param {{size: number, mtimeMs: number}} stat - `fs.stat` 的结果（或其子集）。
 * @returns {string} 带引号的 ETag。
 */
export function etagFor(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'
}
