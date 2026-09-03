import { describe, expect, it } from 'vitest'
import { cleanTranscript } from '../../src/lib/text-cleaner'

describe('cleanTranscript', () => {
  it('删除独立且明确的填充音，并记录原始片段', () => {
    expect(cleanTranscript('えーと、今日は晴れ。')).toEqual({
      rawText: 'えーと、今日は晴れ。',
      cleanedText: '今日は晴れ。',
      changed: true,
      removedSegments: ['えーと、'],
    })
  })

  it('删除标点分隔的完全重复词语', () => {
    expect(cleanTranscript('はい、はい、お願いします')).toEqual({
      rawText: 'はい、はい、お願いします',
      cleanedText: 'はい、お願いします',
      changed: true,
      removedSegments: ['、はい'],
    })
  })

  it('删除完全重复的短语但保留句子内容', () => {
    expect(cleanTranscript('明日は晴れ、明日は晴れ。')).toEqual({
      rawText: '明日は晴れ、明日は晴れ。',
      cleanedText: '明日は晴れ。',
      changed: true,
      removedSegments: ['、明日は晴れ'],
    })
  })

  it('保留有语用意义的表达和自我修正', () => {
    const rawText = 'まあ、なんか、ちょっと、そうですね、うーん、あの。土曜日、じゃなくて日曜日。'

    expect(cleanTranscript(rawText)).toEqual({
      rawText,
      cleanedText: rawText,
      changed: false,
      removedSegments: [],
    })
  })

  it('只在填充音独立时清理，并保留中日混合内容', () => {
    const rawText = 'えーと、今日は Tokyo の会議です。'

    expect(cleanTranscript(rawText)).toEqual({
      rawText,
      cleanedText: '今日は Tokyo の会議です。',
      changed: true,
      removedSegments: ['えーと、'],
    })
  })

  it('空文本保持原样', () => {
    expect(cleanTranscript('')).toEqual({
      rawText: '',
      cleanedText: '',
      changed: false,
      removedSegments: [],
    })
  })

  it('保留嵌在词中的填充音和非完全重复', () => {
    const rawText = '今日はえーと明日です。土曜日、じゃなくて日曜日。'

    expect(cleanTranscript(rawText)).toEqual({
      rawText,
      cleanedText: rawText,
      changed: false,
      removedSegments: [],
    })
  })

  it('清理首尾格式噪声但不改写标点或语序', () => {
    expect(cleanTranscript('  今日は、明日です。  ')).toEqual({
      rawText: '  今日は、明日です。  ',
      cleanedText: '今日は、明日です。',
      changed: true,
      removedSegments: ['  ', '  '],
    })
  })
})
