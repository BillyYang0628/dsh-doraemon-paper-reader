// L0：Python 受管运行环境。用假子进程验证首次创建、复用与依赖哈希。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createPythonRuntime,
  managedPythonPath,
  requirementsDigest,
} from '../src/python-runtime.js'

function fakeChild({ stdout = '', code = 0, onClose } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(async () => {
    try {
      await onClose?.()
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', code)
    } catch (error) {
      child.stderr.emit('data', Buffer.from(String(error)))
      child.emit('close', 1)
    }
  })
  return child
}

test('受管 Python：首次创建 venv、安装依赖、探测并可复用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-python-runtime-'))
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  await mkdir(path.join(packageRoot, '工具', 'pdf-pipeline'), { recursive: true })
  await writeFile(
    path.join(packageRoot, '工具', 'pdf-pipeline', 'requirements.txt'),
    'pdfplumber>=0.11\npypdfium2>=4\nPillow>=10\nmatplotlib>=3.8,<3.10\n',
    'utf8',
  )
  const calls = []
  const executable = managedPythonPath(dataRoot)
  const spawnImpl = (command, args) => {
    calls.push([command, ...args])
    if (args[0] === '--version') return fakeChild({ stdout: 'Python 3.9.13\n' })
    if (args[0] === '-m' && args[1] === 'venv') {
      return fakeChild({
        onClose: async () => {
          await mkdir(path.dirname(executable), { recursive: true })
          await writeFile(executable, 'fake-python', 'utf8')
        },
      })
    }
    if (args.includes('pip')) return fakeChild({ stdout: 'installed\n' })
    if (args[0] === '-c') return fakeChild({ stdout: '10.4.0;3.9.4\n' })
    return fakeChild()
  }
  const runtime = createPythonRuntime({
    dataRoot,
    packageRoot,
    basePython: 'python-test',
    spawnImpl,
  })
  try {
    assert.equal(runtime.status().status, 'idle')
    const first = await runtime.ensure()
    assert.equal(first.status, 'ready')
    assert.equal(first.executable, executable)
    assert.equal(first.pillow, '10.4.0;3.9.4')
    assert.ok(calls.some((call) => call.includes('venv')))
    assert.ok(calls.some((call) => call.includes('pip')))
    assert.ok(calls.some((call) => String(call.at(-1)).includes('matplotlib')))
    const count = calls.length
    const second = await runtime.ensure()
    assert.equal(second.status, 'ready')
    assert.equal(calls.length, count, 'ready 后不应重复安装')
    runtime.reset()
    const inspected = await runtime.inspect()
    assert.equal(inspected.status, 'ready', '重启后应根据 marker 识别已有环境')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('受管 Python：requirements 统一换行后哈希稳定', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-python-hash-'))
  try {
    const lf = path.join(root, 'lf.txt')
    const crlf = path.join(root, 'crlf.txt')
    await writeFile(lf, 'a\nb\n', 'utf8')
    await writeFile(crlf, 'a\r\nb\r\n', 'utf8')
    assert.equal(await requirementsDigest(lf), await requirementsDigest(crlf))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('受管 Python：requirements 必须覆盖公式 SVG 的 matplotlib 运行时', async () => {
  const text = await readFile(
    path.join(process.cwd(), '工具', 'pdf-pipeline', 'requirements.txt'),
    'utf8',
  )
  assert.match(text, /^matplotlib>=3\.8,<3\.10$/m)
})
