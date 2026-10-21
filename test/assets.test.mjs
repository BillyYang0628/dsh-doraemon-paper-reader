// L0：宿主半区静态资源路由的纯逻辑（src/assets.js）。
//
// 这条路由要把包里的插画发给浏览器，所以它同时是一条**安全边界**：
// 目录穿越、绝对路径、盘符、非法扩展名、非 GET/HEAD 都必须被拒。
// 这些用例不碰网络、不碰文件系统，只验判定函数本身。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { ROUTE_PREFIX, etagFor, methodAllowed, mimeFor, resolveAssetPath } from '../src/assets.js'

const ROOT = path.resolve('assets')

test('路由前缀带本包前缀（AGENTS.md §2.3）', () => {
  assert.equal(ROUTE_PREFIX, '/doraemon-paper-reader')
})

test('MIME：只放行界面用得到的图片类型', () => {
  assert.equal(mimeFor('a.webp'), 'image/webp')
  assert.equal(mimeFor('a.PNG'), 'image/png')
  assert.equal(mimeFor('a.jpg'), 'image/jpeg')
  assert.equal(mimeFor('a.svg'), 'image/svg+xml')
  assert.equal(mimeFor('a.js'), undefined)
  assert.equal(mimeFor('a.html'), undefined)
  assert.equal(mimeFor('a'), undefined)
})

test('方法：只服务 GET / HEAD', () => {
  assert.equal(methodAllowed('GET'), true)
  assert.equal(methodAllowed('HEAD'), true)
  assert.equal(methodAllowed('POST'), false)
  assert.equal(methodAllowed('PUT'), false)
  assert.equal(methodAllowed(undefined), false)
})

test('解析：正常路径落到 assets 下的绝对路径', () => {
  const resolved = resolveAssetPath(ROOT, '/doraemon-paper-reader/assets/mascot/a.webp?rev=1')
  assert.equal(resolved, path.join(ROOT, 'mascot', 'a.webp'))
})

test('解析：拒绝一切越界与非法形态', () => {
  const rejected = [
    '/other-plugin/assets/a.webp', // 不是我们的前缀
    '/doraemon-paper-reader/a.webp', // 不在 assets/ 下
    '/doraemon-paper-reader/assets/', // 空文件名
    '/doraemon-paper-reader/assets/a.js', // 扩展名不在白名单
    '/doraemon-paper-reader/assets/../../package.json', // 相对穿越
    '/doraemon-paper-reader/assets/%2e%2e/package.json', // 编码穿越
    '/doraemon-paper-reader/assets/mascot%2f..%2f..%2fpackage.json',
    '/doraemon-paper-reader/assets//etc/passwd', // 空段
    '/doraemon-paper-reader/assets/C:/Windows/win.ini', // 盘符样
    '/doraemon-paper-reader/assets/..\\..\\package.json', // 反斜杠
    '/doraemon-paper-reader/assets/%00.webp', // NUL
    '/doraemon-paper-reader/assets/%ZZ.webp', // 坏编码
    '/doraemon-paper-reader', // 前缀本身不是资源
    '',
  ]
  for (const url of rejected) {
    assert.equal(resolveAssetPath(ROOT, url), null, '必须拒绝：' + url)
  }
})

test('解析：子目录与大小写扩展名照常放行', () => {
  const resolved = resolveAssetPath(ROOT, '/doraemon-paper-reader/assets/mascot/nested/x.WEBP')
  assert.equal(resolved, path.join(ROOT, 'mascot', 'nested', 'x.WEBP'))
})

test('ETag：尺寸 + 修改时间，改了文件就换值', () => {
  const first = etagFor({ size: 74138, mtimeMs: 1761000000000 })
  const second = etagFor({ size: 74138, mtimeMs: 1761000000001 })
  assert.match(first, /^"[0-9a-f]+-[0-9a-f]+"$/)
  assert.notEqual(first, second)
})
