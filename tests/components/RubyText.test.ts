import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { hasRubyMarkup, RubyText } from '../../src/components/RubyText'

describe('RubyText component and helper', () => {
  describe('hasRubyMarkup', () => {
    it('returns false for plain text and empty string', () => {
      expect(hasRubyMarkup('')).toBe(false)
      expect(hasRubyMarkup('こんにちは、元気ですか？')).toBe(false)
      expect(hasRubyMarkup('No brackets here at all')).toBe(false)
    })

    it('returns true when valid ruby bracket syntax is present', () => {
      expect(hasRubyMarkup('[日程|にってい]')).toBe(true)
      expect(hasRubyMarkup('[日程|にってい]を[調整|ちょうせい]いただく')).toBe(true)
    })

    it('returns false for unmatched or malformed brackets', () => {
      expect(hasRubyMarkup('[日程]')).toBe(false)
      expect(hasRubyMarkup('[日程|')).toBe(false)
      expect(hasRubyMarkup('日程|にってい]')).toBe(false)
      expect(hasRubyMarkup('[]')).toBe(false)
      expect(hasRubyMarkup('[|]')).toBe(false)
    })
  })

  describe('RubyText rendering', () => {
    it('renders plain text as is when no ruby markup', () => {
      const html = renderToStaticMarkup(React.createElement(RubyText, { text: '家で映画を見ました。' }))
      expect(html).toBe('家で映画を見ました。')
    })

    it('renders plain text with className when provided', () => {
      const html = renderToStaticMarkup(
        React.createElement(RubyText, { text: 'こんにちは', className: 'custom-class' }),
      )
      expect(html).toBe('<span class="custom-class">こんにちは</span>')
    })

    it('renders single kanji block with valid ruby and rt tags', () => {
      const html = renderToStaticMarkup(React.createElement(RubyText, { text: '[日程|にってい]' }))
      expect(html).toBe(
        '<span lang="ja"><ruby class="ruby-annotated">日程<rt>にってい</rt></ruby></span>',
      )
    })

    it('renders multiple kanji blocks mixed with kana, symbols, and punctuation', () => {
      const html = renderToStaticMarkup(
        React.createElement(RubyText, {
          text: '恐れ入りますが、[日程|にってい]を[調整|ちょうせい]いただくことは[可能|かのう]でしょうか？',
        }),
      )
      expect(html).toBe(
        '<span lang="ja">恐れ入りますが、<ruby class="ruby-annotated">日程<rt>にってい</rt></ruby>を<ruby class="ruby-annotated">調整<rt>ちょうせい</rt></ruby>いただくことは<ruby class="ruby-annotated">可能<rt>かのう</rt></ruby>でしょうか？</span>',
      )
    })

    it('supports showRuby=false to render base text only without ruby tags', () => {
      const html = renderToStaticMarkup(
        React.createElement(RubyText, {
          text: '[日程|にってい]を[調整|ちょうせい]いただく',
          showRuby: false,
        }),
      )
      expect(html).toBe('<span lang="ja">日程を調整いただく</span>')
    })

    it('handles unmatched brackets and punctuation safely', () => {
      const html = renderToStaticMarkup(
        React.createElement(RubyText, {
          text: '[未完の括弧 と [日程|にってい] です]',
        }),
      )
      expect(html).toBe(
        '<span lang="ja">[未完の括弧 と <ruby class="ruby-annotated">日程<rt>にってい</rt></ruby> です]</span>',
      )
    })

    it('handles empty or undefined-like text gracefully', () => {
      const html = renderToStaticMarkup(React.createElement(RubyText, { text: '' }))
      expect(html).toBe('')
    })
  })
})
