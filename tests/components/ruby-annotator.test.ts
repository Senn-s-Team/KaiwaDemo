import { describe, expect, it } from 'vitest'
import { annotateRuby } from '../../src/lib/ruby-annotator'

describe('annotateRuby', () => {
  it('returns empty string for empty input', () => {
    expect(annotateRuby('')).toBe('')
  })

  it('annotates common N2 phrases correctly', () => {
    const input = '来週の月曜日に有給休暇をいただきたいです。'
    const result = annotateRuby(input)
    expect(result).toContain('[来週|らいしゅう]')
    expect(result).toContain('[月曜日|げつようび]')
    expect(result).toContain('[有給休暇|ゆうきゅうきゅうか]')
  })

  it('annotates user sentence from cafe scenario', () => {
    const input = 'おはようございます。私は、普段はカフェラテが好きです。ちょっと、苦くて、ミルクの感じが好きです。'
    const result = annotateRuby(input)
    expect(result).toContain('[私|わたし]')
    expect(result).toContain('[普段|ふだん]')
    expect(result).toContain('[好|す]き')
    expect(result).toContain('[苦|にが]くて')
  })

  it('annotates AI prompt from scenario', () => {
    const input = 'お疲れ様、〇〇さん。改まってどうしたの？何か相談かな？'
    const result = annotateRuby(input)
    expect(result).toContain('お[疲|つか]れ[様|さま]')
    expect(result).toContain('[改|あらた]まって')
    expect(result).toContain('[何|なに]か')
    expect(result).toContain('[相談|そうだん]')
  })

  it('preserves already bracketed ruby segments without double-annotating', () => {
    const input = 'すでに[日程|にってい]が決まりました。'
    const result = annotateRuby(input)
    expect(result).toBe('すでに[日程|にってい]が決まりました。')
  })
})
