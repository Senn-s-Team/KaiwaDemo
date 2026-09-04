import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  ReplyRequest,
  RescueRequest,
  RescueResponse,
  ScenarioId,
} from './types'
import { LIMITS } from './constants'
const MOCK_REPLIES = {
  'weekend-chat': [
    'いいですね。いちばん印象に残ったことも教えてください。',
    '楽しさが伝わりました。具体的な様子もよく分かります。',
    '週末の出来事と感想を確認できました。',
    '素敵な週末でしたね。話してくれてありがとうございます。',
    '週末の様子がよく分かりました。いい時間でしたね。',
  ],
  'order-change': [
    '承知しました。新しいご希望を確認しました。',
    '変更内容が分かりました。この内容でよろしいですか？',
    '分かりました。その内容で確認します。',
    '変更内容は明確です。ご希望を伝えていただきありがとうございます。',
    '変更前と変更後を確認できました。以上で大丈夫です。',
  ],
  'schedule-change': [
    '承知しました。希望日時を確認しました。',
    '変更したい予定と候補日時が分かりました。この内容でよろしいですか？',
    '変更したい日時を確認しました。',
    '必要な日時がそろいました。分かりやすく伝わっています。',
    '変更希望と候補日時を確認できました。ありがとうございます。',
  ],
  'work-progress': [
    'そこまで進んでいるんですね。次に取り組むことは何ですか？',
    '次の作業も分かりました。今、困っていることはありますか？',
    '状況が具体的に伝わりました。次の一歩も明確ですね。',
    '進捗と見通しを確認できました。共有ありがとうございます。',
    '現在地と次の一歩がよく分かりました。以上で大丈夫です。',
  ],
  'conversation-repair': [
    '確認したい情報をもう一度お伝えします。',
    'その内容で合っています。確認できました。',
    'はい、今の確認で意図が伝わりました。',
    '必要な情報を確認できました。ありがとうございます。',
    '内容がはっきりしました。これで確認できました。',
  ],
} as const satisfies Record<ScenarioId, readonly [string, string, string, string, string]>

const REPAIR_FIRST_REPLIES: Record<string, string> = {
  'missing-detail': '打ち合わせは9月12日の午後3時、3階の会議室です。',
  'meaning-check': 'ご予約は10月6日の午前10時30分です。',
}

export function createMockReply(request: ReplyRequest): string {
  if (request.scenarioType === 'dynamic') {
    if (request.turn === 1) return 'ご希望をお聞かせいただきありがとうございます。具体的にどうなさいますか？'
    if (request.turn >= 6) return 'ご要望をしっかり確認できました。こちらで承りますね。'
    return `ご要望について承知しました。第${request.turn}ターンとして確認を進めます。`
  }

  if (request.scenarioId === 'conversation-repair' && request.turn === 1) {
    return REPAIR_FIRST_REPLIES[request.variantId] ?? MOCK_REPLIES['conversation-repair'][0]
  }

  const replies = MOCK_REPLIES[request.scenarioId]
  return replies[Math.min(request.turn - 1, LIMITS.maxTurns - 1)]
}

export function createMockFeedback(request: ConversationFeedbackRequest): ConversationFeedbackResponse {
  const firstRecord = request.transcriptRecords[0]
  const firstQuote = firstRecord?.userFinal || 'ありがとうございます'
  const secondRecord = request.transcriptRecords[1] || firstRecord
  const secondQuote = secondRecord?.userFinal || firstQuote

  return {
    isGoalCompleted: true,
    goalSummaryZh: '顺利完成了场景对话的基本沟通目标，能够清晰传达关键信息。',
    strengths: [
      {
        quoteJa: firstQuote,
        praiseZh: '表达清晰礼貌，准确切中对话核心需求。',
      },
      {
        quoteJa: secondQuote,
        praiseZh: '能够积极响应对方的提问，词汇运用恰当自然。',
      },
    ],
    improvements: [
      {
        turn: firstRecord ? firstRecord.turn : 1,
        type: 'naturalness_upgrade',
        originalQuoteJa: firstQuote,
        suggestedJa: `${firstQuote}、よろしくお願いいたします。`,
        reasonZh: '句尾加上更自然的委婉表达可以使日常交流更加得体。',
      },
    ],
    reusableExpressions: [
      {
        patternJa: '〜していただけますか',
        meaningZh: '礼貌请求对方做某事的常用句型。',
        usageExampleJa: '少々確認していただけますか？',
      },
      {
        patternJa: '〜について伺いたいのですが',
        meaningZh: '用于展开话题或询问特定事项的自然开场表达。',
        usageExampleJa: '予約の変更について伺いたいのですが。',
      },
    ],
    masterUpgrade: {
      turn: firstRecord ? firstRecord.turn : 1,
      originalJa: firstQuote,
      upgradedJa: `恐れ入りますが、${firstQuote}`,
      explanationZh: '使用前置垫话让整个表达兼具客气与专业度。',
    },
    retryTask: {
      turn: firstRecord ? firstRecord.turn : 1,
      targetAiPromptJa: firstRecord?.aiPrompt || 'いらっしゃいませ。',
      userOriginalJa: firstQuote,
      recommendedReferenceJa: `${firstQuote}、確認をお願いできますか。`,
      hintZh: '尝试结合礼貌请求句型重新表达，使交流更加流畅自然。',
    },
  }
}

export function getMockRescueResponse(request: RescueRequest): RescueResponse {
  const raw = request.userFinal.trim() || 'ありがとうございます'
  return {
    interpretedIntentZh: `对方理解你希望传达「${raw.slice(0, 18)}」相关的意图并推进当前事项。`,
    suggestedJa: `恐れ入りますが、${raw}、お願いできますでしょうか。`,
    suggestedJaRuby: `[恐|おそ]れ[入|い]りますが、${raw}、お[願|ねが]いできますでしょうか。`,
    politenessTipZh: '使用「恐れ入りますが」前置垫话与「〜でしょうか」疑问句尾，可使语气更柔和得体。',
  }
}
