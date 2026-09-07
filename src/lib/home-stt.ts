/**
 * [INPUT]: 依赖首页场景中文输入与 STT 会话代际编号
 * [OUTPUT]: 提供首页 STT 结果接纳和识别文字合并的纯规则
 * [POS]: src/lib 的首页中文 STT 状态边界，隔离取消、离页与迟到识别结果对输入框的影响
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
export const HOME_STT_MAX_LENGTH = 300

export function shouldApplyHomeSttResult(resultGeneration: number, currentGeneration: number, pageHidden = false): boolean {
  return resultGeneration === currentGeneration && !pageHidden
}

export function shouldCancelHomeSttForTransition(readyScenario: boolean, awaitingClarification: boolean, busy: boolean): boolean {
  return readyScenario || awaitingClarification || busy
}

export function appendHomeSttText(existing: string, recognized: string, maxLength = HOME_STT_MAX_LENGTH): { text: string; applied: boolean } {
  const current = existing.trim()
  const next = recognized.trim()
  if (!next) return { text: existing, applied: false }
  const separator = current ? '\n' : ''
  if (current.length + separator.length + next.length > maxLength) return { text: existing, applied: false }
  return { text: `${current}${separator}${next}`, applied: true }
}
