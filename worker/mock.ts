/**
 * [INPUT]: 依赖共享听力支架与语音续说契约、其余 Worker 请求/响应类型与固定五轮限制
 * [OUTPUT]: 提供不虚构完成事实的逐项证据回退； 对外提供动态会话、会后反馈、重做反馈、四级听力支架与语音辅助的确定性 mock 响应
 * [POS]: worker 的离线开发回退层，模拟真实接口形状并在第四轮收束、第五轮无问题结束；听力支架只引用当前发话
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ListeningScaffoldRequest, ListeningScaffoldResponse } from '../shared/listening-scaffold'
import type { SpeechAssistRequest, SpeechAssistResponse } from '../shared/speech-assist'
import type {
  DynamicScenarioDefinition,
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  RedoFeedbackRequest,
  RedoFeedbackResponse,
  ReplyRequest,
} from './types'
import { LIMITS } from './constants'

const DYNAMIC_MOCK_REPLIES = [
  '承知しました。必要な内容をもう少し具体的に教えていただけますか？',
  'ありがとうございます。ご希望の要点が分かりました。',
  '内容を確認しました。ほかに必要な条件はありますか？',
  'これまで伺った内容で、ご希望の認識に相違ありませんか？',
  'ご希望の内容を確認できました。以上で承りました。お話しいただき、ありがとうございます。',
] as const

export function createMockReply(request: ReplyRequest): string {
  return DYNAMIC_MOCK_REPLIES[Math.min(request.turn - 1, LIMITS.maxTurns - 1)] ?? DYNAMIC_MOCK_REPLIES[4]
}

export function createMockFeedback(request: ConversationFeedbackRequest, scenario?: DynamicScenarioDefinition): ConversationFeedbackResponse {
  const target = request.turnRecords.at(-1) ?? request.turnRecords[0]
  if (!target) {
    throw new Error('Validated feedback requests must contain turn records.')
  }
  const listeningRecord = request.turnRecords.find((record) => (
    record.listeningScaffoldLevel > 0
    || record.rerecordCount > 0
    || record.failureCount > 0
    || record.retryCount > 0
    || record.textFallback
  ))

  return {
    performance: {
      version: 1,
      dimensions: {
        communicationAchievement: { rating: null, status: 'unobserved', reasonZh: 'mock 模式不生成沟通表现判断。', evidence: [] },
        responseRelevance: { rating: null, status: 'unobserved', reasonZh: 'mock 模式不生成回应关联判断。', evidence: [] },
        expressionClarity: { rating: null, status: 'unobserved', reasonZh: 'mock 模式不生成表达清晰判断。', evidence: [] },
        clarificationRepair: { rating: null, status: 'unobserved', reasonZh: 'mock 模式不生成澄清修复判断。', evidence: [] },
      },
    },
    ...(scenario?.evidencePoints ? { evaluationVersion: scenario.evaluationVersion, evidenceResults: scenario.evidencePoints.map(point => ({pointId: point.id, status: 'insufficient_evidence' as const, evidence: []})) } : {}),
    outcome: 'insufficient_evidence',
    outcomeEvidenceZh: `“${target.userConfirmed}”是实际确认稿；mock 模式不据此虚构唯一目标已经完成。`,
    listeningFinding: listeningRecord
      ? {
          turn: listeningRecord.turn,
          findingZh: '这一轮使用了可观察的听力或输入支架。',
          evidenceZh: `第${listeningRecord.turn}轮记录为L${listeningRecord.listeningScaffoldLevel}，重听${listeningRecord.ttsReplayCount}次。`,
        }
      : null,
    expressionImprovement: null,
    redoTask: {
      turn: target.turn,
      partnerPromptJa: target.partnerPromptJa,
      firstConfirmedJa: target.userConfirmed,
      directionZh: '保留原意，尝试用更具体且符合双方关系的表达完整回应。',
    },
  }
}

export function createMockRedoFeedback(request: RedoFeedbackRequest): RedoFeedbackResponse {
  return {
    comparisonZh: `第一稿“${request.firstConfirmedJa}”与第二稿“${request.secondConfirmedJa}”已按文本进行比较；mock 模式不作超出文字内容的推断。`,
    referenceExpressionJa: request.secondConfirmedJa,
  }
}

export function createMockListeningScaffold(
  request: ListeningScaffoldRequest,
): ListeningScaffoldResponse {
  const keyPhrase = request.partnerPromptJa.slice(0, 30).trim()
  if (keyPhrase.length === 0) {
    throw new Error('Validated listening scaffold requests must contain a partner prompt.')
  }

  return {
    keyInformationHintZh: '请留意对方当前发话中的对象、条件和疑问点，但先不要推断答案。',
    keyPhrasesJa: [keyPhrase],
    intentSummaryZh: '对方正在通过当前发话传达信息或进行确认。',
  }
}

export function createMockSpeechAssist(request: SpeechAssistRequest): SpeechAssistResponse {
  const raw = request.observedTextJa.trim()
  // Strip initial filler if present
  const cleaned = raw.replace(/^(あの|ええと|えーと|その|まー|まぁ)[、\s]*/u, '').trim()
  const cleanedObservedTextJa = cleaned.length > 0 ? cleaned : raw

  let continuationSuggestionJa: string | null = null
  if (!/[。！？?!]$/u.test(raw)) {
    continuationSuggestionJa = 'と思います'
  }

  return {
    cleanedObservedTextJa,
    continuationSuggestionJa,
  }
}
