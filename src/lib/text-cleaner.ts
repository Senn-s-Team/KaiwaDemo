export interface TranscriptCleanupResult {
  rawText: string
  cleanedText: string
  changed: boolean
  removedSegments: string[]
}

const FILLERS = ['えーと', 'えっと', 'ええと', 'あのー', 'えー'] as const
const BOUNDARY = '[\\s、。！？!?，,；;：:「」『』【】（）()\\[\\]《》〈〉…—.．]'
const FILLER_PATTERN = new RegExp(
  `(^|${BOUNDARY})(${FILLERS.join('|')})(?=[、，,\\s]|$|${BOUNDARY})([、，,]?)(\\s*)`,
  'gu',
)
const DUPLICATE_PATTERN = new RegExp(
  `([^\\s、。！？!?，,；;：:「」『』【】（）()\\[\\]《》〈〉…—.．]+)(\\s+|[、。！？!?，,；;：:「」『』【】（）()\\[\\]《》〈〉…—.．])\\1([、。！？!?，,；;：:「」『』【】（）()\\[\\]《》〈〉…—.．])?(?=$|${BOUNDARY})`,
  'gu',
)

function removeOuterFormatNoise(text: string, removedSegments: string[]): string {
  let result = text.replace(/^\uFEFF/u, () => {
    removedSegments.push('\uFEFF')
    return ''
  })

  result = result.replace(/\r\n?/gu, '\n')

  const leading = result.match(/^\s+/u)?.[0]
  if (leading) {
    removedSegments.push(leading)
    result = result.slice(leading.length)
  }

  const trailing = result.match(/\s+$/u)?.[0]
  if (trailing) {
    removedSegments.push(trailing)
    result = result.slice(0, -trailing.length)
  }

  return result
}

function removeFillers(text: string, removedSegments: string[]): string {
  return text.replace(
    FILLER_PATTERN,
    (_match, left: string, filler: string, punctuation: string, whitespace: string) => {
      removedSegments.push(`${filler}${punctuation}${whitespace}`)
      return whitespace && /^[ 	]$/u.test(left) ? '' : left
    },
  )
}

function removeRepeatedUnits(text: string, removedSegments: string[]): string {
  let result = text

  while (true) {
    const next = result.replace(
      DUPLICATE_PATTERN,
      (_match, unit: string, separator: string, trailing: string | undefined) => {
        removedSegments.push(`${separator}${unit}`)
        return `${unit}${trailing ?? ''}`
      },
    )

    if (next === result) return result
    result = next
  }
}

export function cleanTranscript(rawText: string): TranscriptCleanupResult {
  const removedSegments: string[] = []
  let cleanedText = removeOuterFormatNoise(rawText, removedSegments)
  cleanedText = removeFillers(cleanedText, removedSegments)
  cleanedText = removeRepeatedUnits(cleanedText, removedSegments)

  return {
    rawText,
    cleanedText,
    changed: cleanedText !== rawText,
    removedSegments,
  }
}
