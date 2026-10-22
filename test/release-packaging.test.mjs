import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('发布包：插件与 audit-lab 版本同步', async () => {
  const plugin = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const lab = JSON.parse(await readFile(path.join(root, 'audit-lab', 'package.json'), 'utf8'))
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
  const latest = /^##\s+([0-9]+\.[0-9]+\.[0-9]+)/m.exec(changelog)?.[1]
  assert.equal(plugin.version, lab.version)
  assert.equal(plugin.version, latest)
  assert.equal(lab.private, true)
})

test('发布包：插件白名单包含安装文档并排除迭代目录', async () => {
  const plugin = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(plugin.files.includes('INSTALL.md'))
  assert.ok(plugin.files.includes('CONTRIBUTING.md'))
  assert.ok(plugin.files.includes('THIRD_PARTY_NOTICES.md'))
  assert.ok(!plugin.files.includes('audit-lab'))
  assert.ok(!plugin.files.includes('test'))
})

test('发布包：宿主启动日志读取 package.json 版本', async () => {
  const source = await readFile(path.join(root, 'src', 'index.js'), 'utf8')
  assert.match(source, /PACKAGE_VERSION/)
  assert.doesNotMatch(source, /host half loaded \(v0\.1\.0\)/)
})
