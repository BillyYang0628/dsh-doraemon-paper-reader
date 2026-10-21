#!/usr/bin/env node
// 手动预装/修复 DSH 数据目录下的受管 Python 环境。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPythonRuntime } from '../../src/python-runtime.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataRoot = path.join(
  process.env.DSH_HOME || 'D:/DSH/home',
  'doraemon-paper-reader',
)
const runtime = createPythonRuntime({
  dataRoot,
  packageRoot,
  basePython: process.env.DPR_PYTHON || 'python',
})

try {
  const ready = await runtime.ensure()
  console.log(JSON.stringify(ready, null, 2))
} catch (error) {
  console.error(JSON.stringify(runtime.status(), null, 2))
  console.error(error?.message || String(error))
  process.exitCode = 1
}
