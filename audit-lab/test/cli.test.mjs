import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const cli = path.join(root, 'cli.mjs')

test('审计实验室：自检能定位管线和公共案例', () => {
  const output = execFileSync(process.execPath, [cli, 'self-check'], {
    cwd: path.resolve(root, '..'),
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.equal(result.lab, 'dsh-doraemon-paper-reader-audit-lab')
  assert.ok(result.publicCases >= 7)
})

test('审计实验室：帮助文本明确与插件运行代码分离', () => {
  const output = execFileSync(process.execPath, [cli, '--help'], {
    cwd: path.resolve(root, '..'),
    encoding: 'utf8',
  })
  assert.match(output, /extract.*reconcile.*audit/)
  assert.match(output, /不改写 MirrorDoc/)
})
