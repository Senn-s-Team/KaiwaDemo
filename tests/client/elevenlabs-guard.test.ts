import { describe, expect, it } from 'vitest'
import {
  findPackageJsonUpwards,
  resolveElevenLabsScribeEntry,
  validateElevenLabsScribeEntry,
} from '../../scripts/elevenlabs-guard'
describe('ElevenLabs Scribe entry build guard', () => {
  it('正确解析当前环境的声明版本、安装版本与入口文件路径', () => {
    const entry = resolveElevenLabsScribeEntry(import.meta.url)
    expect(entry).toContain('node_modules/@elevenlabs/client/dist/scribe/index.js')
  })

  it('当 package exports 不暴露 ./package.json 时，仍可通过已解析入口向上查找到真实 package.json', () => {
    const fsMock: Record<string, string> = {
      '/app/node_modules/@elevenlabs/client/package.json': JSON.stringify({
        name: '@elevenlabs/client',
        version: '1.23.0',
      }),
      '/app/node_modules/@elevenlabs/client/dist/platform/web/index.js': '// entry',
    }

    const result = findPackageJsonUpwards(
      '/app/node_modules/@elevenlabs/client/dist/platform/web',
      (pkg) => pkg.name === '@elevenlabs/client',
      (p) => fsMock[p] ?? '',
      (p) => p in fsMock,
    )

    expect(result.dir).toBe('/app/node_modules/@elevenlabs/client')
    expect(result.pkg.version).toBe('1.23.0')
  })

  it('当向上查找到根目录仍未能匹配到正确的 package name 时明确失败', () => {
    const fsMock: Record<string, string> = {
      '/app/node_modules/wrong-pkg/package.json': JSON.stringify({
        name: 'other-package',
        version: '1.0.0',
      }),
    }

    expect(() =>
      findPackageJsonUpwards(
        '/app/node_modules/wrong-pkg/dist',
        (pkg) => pkg.name === '@elevenlabs/client',
        (p) => fsMock[p] ?? '',
        (p) => p in fsMock,
      ),
    ).toThrowError(/向上找不到匹配的 package.json/)
  })

  it('当声明版本不是精确版本时（例如含有 ^ 或 ~）抛出明确错误', () => {
    expect(() =>
      validateElevenLabsScribeEntry(
        {
          declaredVersion: '^1.23.0',
          installedVersion: '1.23.0',
          targetEntryPath: '/path/to/dist/scribe/index.js',
        },
        () => true,
      ),
    ).toThrowError(/必须为精确版本号/)

    expect(() =>
      validateElevenLabsScribeEntry(
        {
          declaredVersion: '~1.23.0',
          installedVersion: '1.23.0',
          targetEntryPath: '/path/to/dist/scribe/index.js',
        },
        () => true,
      ),
    ).toThrowError(/必须为精确版本号/)
  })

  it('当声明版本与已安装版本不一致时抛出明确错误', () => {
    expect(() =>
      validateElevenLabsScribeEntry(
        {
          declaredVersion: '1.23.0',
          installedVersion: '1.24.0',
          targetEntryPath: '/path/to/dist/scribe/index.js',
        },
        () => true,
      ),
    ).toThrowError(/声明版本 \("1.23.0"\) 与实际安装版本 \("1.24.0"\) 不一致/)
  })

  it('当推导的目标入口文件不存在时抛出明确错误', () => {
    expect(() =>
      validateElevenLabsScribeEntry(
        {
          declaredVersion: '1.23.0',
          installedVersion: '1.23.0',
          targetEntryPath: '/non/existent/dist/scribe/index.js',
        },
        () => false,
      ),
    ).toThrowError(/无法找到期望的 Scribe 入口文件/)
  })

  it('所有条件均满足时返回目标入口路径', () => {
    const path = '/valid/path/dist/scribe/index.js'
    const result = validateElevenLabsScribeEntry(
      {
        declaredVersion: '1.23.0',
        installedVersion: '1.23.0',
        targetEntryPath: path,
      },
      () => true,
    )
    expect(result).toBe(path)
  })
})
