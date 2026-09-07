/**
 * [INPUT]: 依赖 node:fs、node:path、node:module 的 createRequire、node:url 的 fileURLToPath
 * [OUTPUT]: 对外提供 findPackageJsonUpwards、resolveElevenLabsScribeEntry、validateElevenLabsScribeEntry 函数及类型
 * [POS]: 构建辅助工具模块，用于 vite.config.ts 动态校验 @elevenlabs/client 版本锁定及私有 Scribe 入口文件的存在性
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export interface ScribeEntryValidationInput {
  declaredVersion: string
  installedVersion: string
  targetEntryPath: string
}

export function validateElevenLabsScribeEntry(
  input: ScribeEntryValidationInput,
  fileExists: (filePath: string) => boolean = fs.existsSync,
): string {
  const { declaredVersion, installedVersion, targetEntryPath } = input

  // 1. 严格检查声明版本是否为精确版本（禁止 ^, ~, >, <, *）
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(declaredVersion)) {
    throw new Error(
      `[ElevenLabs Guard] package.json 中 @elevenlabs/client 必须为精确版本号（当前为: "${declaredVersion}"），以防内部路径静默破坏。`,
    )
  }

  // 2. 检查实际安装版本与声明版本是否完全一致
  if (declaredVersion !== installedVersion) {
    throw new Error(
      `[ElevenLabs Guard] @elevenlabs/client 声明版本 ("${declaredVersion}") 与实际安装版本 ("${installedVersion}") 不一致，请重新运行 npm install。`,
    )
  }

  // 3. 检查推导出的目标入口文件是否存在
  if (!fileExists(targetEntryPath)) {
    throw new Error(
      `[ElevenLabs Guard] @elevenlabs/client 无法找到期望的 Scribe 入口文件 "${targetEntryPath}"。请确认依赖版本兼容性。`,
    )
  }

  return targetEntryPath
}

export function findPackageJsonUpwards(
  startDir: string,
  predicate: (pkg: { name?: string; version?: string; dependencies?: Record<string, string> }) => boolean,
  fileReader: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  fileExists: (p: string) => boolean = fs.existsSync,
): { dir: string; pkgPath: string; pkg: { name?: string; version?: string; dependencies?: Record<string, string> } } {
  let currentDirectory = path.resolve(startDir)
  while (true) {
    const pkgPath = path.join(currentDirectory, 'package.json')
    if (fileExists(pkgPath)) {
      try {
        const pkg = JSON.parse(fileReader(pkgPath)) as {
          name?: string
          version?: string
          dependencies?: Record<string, string>
        }
        if (predicate(pkg)) {
          return { dir: currentDirectory, pkgPath, pkg }
        }
      } catch {
        // 忽略畸形 package.json，继续向上查找
      }
    }
    const parent = path.dirname(currentDirectory)
    if (parent === currentDirectory) {
      throw new Error(`[ElevenLabs Guard] 向上找不到匹配的 package.json。起始目录: ${startDir}`)
    }
    currentDirectory = parent
  }
}

export function resolveElevenLabsScribeEntry(importMetaUrl: string): string {
  const req = createRequire(importMetaUrl)
  const startDir = path.dirname(fileURLToPath(importMetaUrl))
  const { pkg: projectPkg } = findPackageJsonUpwards(
    startDir,
    (pkg) => Boolean(pkg.dependencies && ('@elevenlabs/client' in pkg.dependencies || pkg.name === 'kaiwademo')),
  )
  const declaredVersion = projectPkg.dependencies?.['@elevenlabs/client'] ?? ''

  // 2. 从公开入口 '@elevenlabs/client' 向上查找确认 name === '@elevenlabs/client' 的 package.json
  const resolvedEntry = req.resolve('@elevenlabs/client')
  const { dir: packageDir, pkg: installedPkg } = findPackageJsonUpwards(
    path.dirname(resolvedEntry),
    (pkg) => pkg.name === '@elevenlabs/client',
  )
  const installedVersion = installedPkg.version ?? ''

  // 3. 推导 dist/scribe/index.js 绝对路径
  const targetEntryPath = path.join(packageDir, 'dist', 'scribe', 'index.js')

  return validateElevenLabsScribeEntry({
    declaredVersion,
    installedVersion,
    targetEntryPath,
  })
}
