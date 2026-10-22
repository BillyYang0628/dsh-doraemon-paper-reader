#!/usr/bin/env node
// 从当前工作树生成两个独立发布物：DSH 插件 tgz 与 audit-lab tgz。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..', '..')
const dist = path.join(root, 'dist')
const allowDirty = process.argv.includes('--allow-dirty')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const labPackageJson = JSON.parse(await readFile(path.join(root, 'audit-lab', 'package.json'), 'utf8'))
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')

const headingIndex = changelog.indexOf(`## ${packageJson.version}`)
if (headingIndex < 0) throw new Error(`CHANGELOG.md 缺少 ${packageJson.version} 发布说明`)
const bodyStart = changelog.indexOf('\n', headingIndex) + 1
const nextHeading = changelog.indexOf('\n## ', bodyStart)
const body = changelog.slice(bodyStart, nextHeading < 0 ? changelog.length : nextHeading).trim()
if (!body) throw new Error(`${packageJson.version} 发布说明正文为空`)
const releaseNotes = `# ${packageJson.name} v${packageJson.version}\n\n${body}\n`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${command} 失败${detail ? '：' + detail : ''}`)
  }
  return result
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase()
}

function npmInvocation() {
  const npmCli = process.env.npm_execpath
  if (npmCli) return { command: process.execPath, prefix: [npmCli] }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] }
}

async function copyFiltered(source, target, shouldInclude) {
  await cp(source, target, {
    recursive: true,
    filter: (entry) => shouldInclude(path.relative(source, entry), entry),
  })
}

async function createAuditLabTarball() {
  const artifactName = `${labPackageJson.name}-${labPackageJson.version}.tgz`
  const artifact = path.join(dist, artifactName)
  const staging = path.join(dist, `.audit-lab-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await copyFiltered(path.join(root, 'audit-lab'), staging, (relative) => {
      const parts = relative.split(path.sep)
      if (parts.includes('work') || parts.includes('node_modules')) return false
      if (relative.startsWith(path.join('cases', 'private'))) return false
      if (path.basename(relative) === '.DS_Store') return false
      return true
    })

    await cp(path.join(root, '工具', 'pdf-pipeline'), path.join(staging, 'pdf-pipeline'), {
      recursive: true,
      filter: (entry) => !entry.split(path.sep).includes('__pycache__'),
    })

    const docsDir = path.join(staging, 'docs')
    await mkdir(docsDir, { recursive: true })
    for (const name of await readdir(path.join(root, 'docs'))) {
      if (!name.startsWith('PDF审计') && name !== 'PDF审计开源分支规划-v1.md') continue
      await cp(path.join(root, 'docs', name), path.join(docsDir, name))
    }

    await cp(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'))
    await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'))

    await rm(artifact, { force: true })
    run('tar', ['-czf', artifact, '-C', staging, '.'])
    const list = run('tar', ['-tzf', artifact], { capture: true }).stdout
    const required = [
      './cli.mjs',
      './package.json',
      './pdf-pipeline/extract_pdf.py',
      './pdf-pipeline/audit_structure.py',
      './pdf-pipeline/regression_cases.json',
      './LICENSE',
    ]
    for (const entry of required) {
      if (!list.split(/\r?\n/).includes(entry)) throw new Error(`audit-lab 包缺少 ${entry}`)
    }
    if (list.split(/\r?\n/).some((entry) => entry.startsWith('./src/'))) {
      throw new Error('audit-lab 包意外包含插件 src/ 代码')
    }
    return artifact
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const status = run('git', ['status', '--porcelain'], { capture: true }).stdout.trim()
if (status && !allowDirty) {
  throw new Error('工作树有未提交改动。正式发布请先提交；本地候选可加 --allow-dirty。')
}
const commit = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim()

await mkdir(dist, { recursive: true })
const npm = npmInvocation()
const packed = run(npm.command, [...npm.prefix, 'pack', '--json', '--pack-destination', dist], {
  capture: true,
})
let packInfo
try {
  packInfo = JSON.parse(packed.stdout)
} catch {
  throw new Error('npm pack 没有返回可解析的 JSON')
}
const plugin = packInfo[0]
const pluginFiles = new Set((plugin.files || []).map((entry) => entry.path))
const requiredPluginFiles = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'INSTALL.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'icon.svg',
  'src/index.js',
  'src/client.js',
  'src/python-runtime.js',
  '工具/pdf-pipeline/extract_pdf.py',
  '工具/pdf-pipeline/audit_structure.py',
  '工具/dev/setup-python.mjs',
  'assets/vendor/katex/katex.min.js',
]
for (const entry of requiredPluginFiles) {
  if (!pluginFiles.has(entry)) throw new Error(`插件包缺少 ${entry}`)
}
const forbiddenPluginPrefixes = ['audit-lab/', 'test/', '工具/gen/', '.github/', 'dist/']
for (const entry of pluginFiles) {
  if (forbiddenPluginPrefixes.some((prefix) => entry.startsWith(prefix))) {
    throw new Error(`插件包不应包含 ${entry}`)
  }
  if (entry.includes('__pycache__') || entry.endsWith('.pyc')) {
    throw new Error(`插件包包含 Python 缓存 ${entry}`)
  }
}

const auditArtifact = await createAuditLabTarball()
const pluginArtifact = path.join(dist, plugin.filename)
const artifactRows = []
for (const [kind, file, install] of [
  ['dsh-plugin', pluginArtifact, '通过 DSH 插件页或 dsh plugin add 安装'],
  ['audit-lab', auditArtifact, '解压后运行 npm test 或 node cli.mjs self-check'],
]) {
  const buffer = await readFile(file)
  const info = await stat(file)
  artifactRows.push({
    kind,
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    bytes: info.size,
    sha256: sha256(buffer),
    install,
  })
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    commit,
    dirty: Boolean(status),
    releaseCandidate: Boolean(status),
  },
  plugin: {
    name: packageJson.name,
    version: packageJson.version,
    dsh: packageJson.engines?.dsh,
    node: packageJson.engines?.node,
    fileCount: plugin.entryCount || plugin.files?.length || 0,
    unpackedBytes: plugin.unpackedSize || 0,
  },
  auditLab: {
    name: labPackageJson.name,
    version: labPackageJson.version,
  },
  releaseNotes: `dist/RELEASE_NOTES-${packageJson.version}.md`,
  artifacts: artifactRows,
}

await writeFile(path.join(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
await writeFile(path.join(dist, `RELEASE_NOTES-${packageJson.version}.md`), releaseNotes, 'utf8')
await writeFile(
  path.join(dist, 'SHA256SUMS.txt'),
  artifactRows.map((item) => `${item.sha256}  ${path.basename(item.file)}`).join('\n') + '\n',
  'utf8',
)

console.log(
  JSON.stringify(
    {
      ok: true,
      releaseCandidate: manifest.source.releaseCandidate,
      artifacts: manifest.artifacts,
      manifest: 'dist/release-manifest.json',
      releaseNotes: manifest.releaseNotes,
      checksums: 'dist/SHA256SUMS.txt',
    },
    null,
    2,
  ),
)
