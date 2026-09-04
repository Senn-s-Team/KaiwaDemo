import React from 'react'

export interface RubyTextProps {
  text: string
  showRuby?: boolean
  className?: string
  'data-testid'?: string
}


export function hasRubyMarkup(text: string): boolean {
  if (!text) return false
  const regex = /\[([^|[\]]+)\|([^|[\]]+)\]/
  return regex.test(text)
}

export function RubyText({
  text,
  showRuby = true,
  className,
  'data-testid': testId,
}: RubyTextProps): React.ReactElement | null {
  if (!text) return null

  if (!hasRubyMarkup(text)) {
    return className || testId ? (
      <span className={className} data-testid={testId}>
        {text}
      </span>
    ) : (
      <>{text}</>
    )
  }

  const elements: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  const rubyRegex = /\[([^|[\]]+)\|([^|[\]]+)\]/g

  while ((match = rubyRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(text.slice(lastIndex, match.index))
    }
    const base = match[1]
    const ruby = match[2]

    if (showRuby) {
      elements.push(
        <ruby key={key++} className="ruby-annotated">
          {base}
          <rt>{ruby}</rt>
        </ruby>,
      )
    } else {
      elements.push(base)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    elements.push(text.slice(lastIndex))
  }

  return (
    <span className={className} data-testid={testId} lang="ja">
      {elements}
    </span>
  )
}
