// 宿主半区：Python 受管运行环境。
//
// 目标不是替代系统 Python，而是把所有插件运行依赖隔离到 D 盘数据目录：
//   $DSH_HOME/doraemon-paper-reader/python-env
// 首次使用时用基础 Python 创建 venv，之后 PDF/视觉/公式任务只调用该解释器。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'

function executableFor(root) {
  return process.platform === 'win32'
    ? path.join(root, 'Scripts', 'python.exe')
    : path.join(root, 'bin', 'python')
}

function cleanError(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

async function exists(file) {
  try {
    await access(file, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function requirementsDigest(file) {
  const text = await readFile(file, 'utf8')
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

export function managedPythonPath(dataRoot) {
  return executableFor(path.join(dataRoot, 'python-env'))
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = (options.spawnImpl || spawn)(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: options.env,
      })
    } catch (error) {
      reject(error)
      return
    }
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
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(cleanError(stderr) || `${command} 退出码 ${code}`))
    })
  })
}

async function baseCandidates(preferred) {
  const values = [
    preferred,
    process.env.DPR_BASE_PYTHON,
    process.platform === 'win32' ? 'D:\\Python\\python.exe' : '',
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python',
  ].filter(Boolean)
  return [...new Set(values)]
}

/**
 * 创建受管 Python 运行时。ensure() 并发安全，失败后允许下次重试。
 * @param {{dataRoot: string, packageRoot: string, basePython?: string, spawnImpl?: Function}} options - 运行环境。
 * @returns {{ensure: Function, status: Function, reset: Function}} 运行时控制器。
 */
export function createPythonRuntime({
  dataRoot,
  packageRoot,
  basePython = 'python',
  spawnImpl = spawn,
}) {
  const envRoot = path.join(dataRoot, 'python-env')
  const executable = executableFor(envRoot)
  const marker = path.join(envRoot, '.doraemon-runtime.json')
  const requirements = path.join(packageRoot, '工具', 'pdf-pipeline', 'requirements.txt')
  const pipCache = path.join(dataRoot, 'python-pip-cache')
  const tempRoot = path.join(dataRoot, 'python-tmp')
  let pending = null
  let state = { status: 'idle', executable, envRoot, error: '' }

  const status = () => ({ ...state })

  const inspect = async () => {
    if (pending) return pending
    if (state.status !== 'idle') return status()
    const digest = await requirementsDigest(requirements).catch(() => '')
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8'))
      if (
        digest &&
        saved?.requirementsHash === digest &&
        saved?.executable === executable &&
        (await exists(executable))
      ) {
        state = {
          status: 'ready',
          executable,
          envRoot,
          requirementsHash: digest,
          pillow: saved.pillow || '',
          builtAt: saved.builtAt || '',
          error: '',
        }
      }
    } catch {
      // 没有 marker 时保持 idle，等实际任务再安装。
    }
    return status()
  }

  const ensure = () => {
    if (pending) return pending
    if (state.status === 'ready' && state.executable) return Promise.resolve(status())
    pending = (async () => {
      state = { ...state, status: 'preparing', error: '', startedAt: new Date().toISOString() }
      await mkdir(pipCache, { recursive: true })
      await mkdir(tempRoot, { recursive: true })
      const digest = await requirementsDigest(requirements)
      let saved = null
      try {
        saved = JSON.parse(await readFile(marker, 'utf8'))
      } catch {
        saved = null
      }
      const childEnv = {
        ...process.env,
        PIP_CACHE_DIR: pipCache,
        TMP: tempRoot,
        TEMP: tempRoot,
        PYTHONIOENCODING: 'utf-8',
      }
      if (!(await exists(executable)) || saved?.requirementsHash !== digest) {
        let base = ''
        let lastError = null
        for (const candidate of await baseCandidates(basePython)) {
          try {
            await run(candidate, ['--version'], { cwd: packageRoot, env: childEnv, spawnImpl })
            base = candidate
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!base) {
          throw new Error('找不到可用于创建受管 Python 环境的基础解释器：' + (lastError?.message || ''))
        }
        state.basePython = base
        await run(base, ['-m', 'venv', envRoot], {
          cwd: packageRoot,
          env: childEnv,
          spawnImpl,
        })
        await run(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], {
          cwd: packageRoot,
          env: childEnv,
          spawnImpl,
        })
      }
      const probe = await run(
        executable,
        [
          '-c',
          'import pdfplumber, pypdfium2, PIL, matplotlib; print(PIL.__version__ + ";" + matplotlib.__version__)',
        ],
        { cwd: packageRoot, env: childEnv, spawnImpl },
      )
      const info = await stat(executable)
      const record = {
        version: 1,
        requirementsHash: digest,
        executable,
        builtAt: new Date().toISOString(),
        executableBytes: info.size,
        pillow: cleanError(probe.stdout),
      }
      await writeFile(marker, JSON.stringify(record, null, 2), 'utf8')
      state = {
        status: 'ready',
        executable,
        envRoot,
        requirementsHash: digest,
        pillow: record.pillow,
        builtAt: record.builtAt,
        error: '',
      }
      return status()
    })()
      .catch((error) => {
        state = {
          ...state,
          status: 'failed',
          error: cleanError(error?.message || error),
          finishedAt: new Date().toISOString(),
        }
        throw error
      })
      .finally(() => {
        pending = null
      })
    return pending
  }

  return {
    ensure,
    inspect,
    status,
    reset() {
      state = { status: 'idle', executable, envRoot, error: '' }
    },
  }
}
