/**
 * [INPUT]: 完成页 view model、反馈恢复状态与完成页用户动作
 * [OUTPUT]: 渲染证据反馈、重做练习、报告操作与本机练习状态
 * [POS]: src/components 的完成页视图；不拥有反馈任务轮询、持久化或会话编排
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { Mic, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { requestElevenLabsToken, requestListeningScaffold } from '../lib/api'
import { cleanTranscript } from '../lib/text-cleaner'
import { RealtimeSttSession } from '../lib/stt'
import { comparePracticeAttempts } from '../lib/practice-progress'
import type { ListeningScaffoldResponse } from '../../shared/listening-scaffold'
import type { StoredFeedbackTask } from '../lib/feedback-task-recovery'
import type { ConversationFeedbackResponse, ConversationMessage, FeedbackLoadingState, ListeningScaffoldLevel, PrototypeConfig, RedoFeedbackRequest, RoundRecord, SessionReport, SessionScenario } from '../types'

const LISTENING_LEVEL_LABELS: Record<ListeningScaffoldLevel, string> = {
  0: '未使用', 1: '重听过', 2: '看过关键信息', 3: '看过日语台词', 4: '看过意图说明',
}

function nextListeningAction(level: ListeningScaffoldLevel): string | null {
  if (level === 0) return '先重听一遍'
  if (level === 1) return '查看关键信息'
  if (level === 2) return '查看日语台词'
  if (level === 3) return '查看这句话想表达什么'
  return null
}

interface SessionCompleteProps {
  messages: ConversationMessage[]
  rounds: RoundRecord[]
  report: SessionReport
  sessionId: string
  scenario: SessionScenario
  reveal: SessionScenario['reveal']
  config: PrototypeConfig | null
  feedbackData: ConversationFeedbackResponse | null
  feedbackStatus: FeedbackLoadingState
  feedbackErrorMsg: string
  restoredRedoTask?: StoredFeedbackTask
  onRetryFeedback: () => void
  copyStatus: string
  onCopy: () => void
  onDownload: () => void
  onReplayAi: (text: string) => void
  onStopAudio: () => void
  onRequestRedo: (request: RedoFeedbackRequest) => void
  onRequestListeningScaffold: typeof requestListeningScaffold
  onCacheListeningScaffold: (messageId: string, scaffold: ListeningScaffoldResponse) => void
  onNewScenario: () => void
  audioNotice: string
  practiceComparison: ReturnType<typeof comparePracticeAttempts> | null
  onRepeatScenario?: () => void
  historyNotice: string
  onRetrySave?: () => void
}

export function SessionComplete({
  messages,
  rounds,
  report,
  sessionId,
  scenario,
  reveal,
  config,
  feedbackData,
  feedbackStatus,
  feedbackErrorMsg,
  restoredRedoTask,
  onRetryFeedback,
  copyStatus,
  onCopy,
  onDownload,
  onReplayAi,
  onStopAudio,
  onRequestRedo,
  onRequestListeningScaffold,
  onCacheListeningScaffold,
  onNewScenario,
  audioNotice,
  practiceComparison,
  onRepeatScenario,
  historyNotice,
  onRetrySave,
}: SessionCompleteProps): React.JSX.Element {
  const [redoState, setRedoState] = useState<'idle' | 'ready' | 'recording' | 'confirming' | 'loading' | 'complete'>('idle')
  const [redoTranscript, setRedoTranscript] = useState('')
  const [redoInputMode, setRedoInputMode] = useState<'stt' | 'text'>('stt')
  const [redoListeningLevel, setRedoListeningLevel] = useState<ListeningScaffoldLevel>(0)
  const [redoExpressionLevel, setRedoExpressionLevel] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [redoResult, setRedoResult] = useState<{ comparisonZh: string; referenceExpressionJa: string } | null>(null)
  const [redoError, setRedoError] = useState('')
  const [redoScaffold, setRedoScaffold] = useState<ListeningScaffoldResponse | null>(null)
  const [redoScaffoldLoading, setRedoScaffoldLoading] = useState(false)
  const [redoScaffoldError, setRedoScaffoldError] = useState('')
  const redoSttRef = useRef<RealtimeSttSession | null>(null)
  const redoScaffoldRequestInFlightRef = useRef(false)
  const redoGenerationRef = useRef(0)
  const redoMountedRef = useRef(true)
  const redoStartLockRef = useRef(false)
  const redoSubmitLockRef = useRef(false)

  useEffect(() => {
    if (!restoredRedoTask || restoredRedoTask.request.kind !== 'redo') return
    const payload = restoredRedoTask.request.payload
    setRedoTranscript(payload.secondConfirmedJa)
    setRedoInputMode(payload.secondInputMode)
    setRedoListeningLevel(payload.secondListeningScaffoldLevel)
    setRedoExpressionLevel(payload.secondExpressionScaffoldLevel)
    if (restoredRedoTask.status === 'complete' && restoredRedoTask.result
      && 'comparisonZh' in restoredRedoTask.result && 'referenceExpressionJa' in restoredRedoTask.result) {
      setRedoResult({ comparisonZh: restoredRedoTask.result.comparisonZh, referenceExpressionJa: restoredRedoTask.result.referenceExpressionJa })
      setRedoState('complete')
    } else if (restoredRedoTask.status === 'pending' || restoredRedoTask.status === 'transport_error') {
      setRedoState('loading')
    } else if (restoredRedoTask.status === 'failed') {
      setRedoState('confirming')
      setRedoError(restoredRedoTask.error?.message ?? '重做反馈生成失败，请确认回答后重试。')
    }
  }, [restoredRedoTask])

  useEffect(() => () => {
    redoMountedRef.current = false
    redoGenerationRef.current += 1
    redoStartLockRef.current = false
    redoSubmitLockRef.current = false
    redoSttRef.current?.close()
    redoSttRef.current = null
  }, [])
  const redoAssistantMessage = feedbackData
    ? messages.find((message) => message.role === 'assistant' && message.turn === feedbackData.redoTask.turn)
    : undefined
  const effectiveRedoScaffold = redoScaffold ?? redoAssistantMessage?.listeningScaffold ?? null


  const startRedo = () => {
    if (!feedbackData) return
    redoGenerationRef.current += 1
    redoStartLockRef.current = false
    redoSubmitLockRef.current = false
    onStopAudio()
    redoSttRef.current?.close()
    setRedoState('ready')
    setRedoInputMode('stt')
    setRedoListeningLevel(1)
    setRedoExpressionLevel(0)
    setRedoResult(null)
    setRedoError('')
    setRedoScaffold(redoAssistantMessage?.listeningScaffold ?? null)
    setRedoScaffoldLoading(false)
    setRedoScaffoldError('')
    onReplayAi(feedbackData.redoTask.partnerPromptJa)
  }

  const advanceRedoListeningScaffold = async () => {
    if (!feedbackData || redoScaffoldRequestInFlightRef.current) return
    if (redoListeningLevel === 0) {
      setRedoListeningLevel(1)
      onReplayAi(feedbackData.redoTask.partnerPromptJa)
      return
    }
    if (redoListeningLevel === 1) {
      if (effectiveRedoScaffold) {
        setRedoListeningLevel(2)
        setRedoScaffoldError('')
        return
      }
      setRedoScaffoldLoading(true)
      setRedoScaffoldError('')
      redoScaffoldRequestInFlightRef.current = true
      const generation = redoGenerationRef.current
      const expectedSessionId = sessionId
      const expectedTurn = feedbackData.redoTask.turn
      try {
        const scaffold = await onRequestListeningScaffold({
          scenarioType: 'dynamic',
          sessionToken: scenario.sessionToken,
          turn: feedbackData.redoTask.turn,
          partnerPromptJa: feedbackData.redoTask.partnerPromptJa,
        })
        if (!redoMountedRef.current || generation !== redoGenerationRef.current || sessionId !== expectedSessionId || !feedbackData || feedbackData.redoTask.turn !== expectedTurn) return
        setRedoScaffold(scaffold)
        setRedoListeningLevel(2)
        if (redoAssistantMessage) onCacheListeningScaffold(redoAssistantMessage.id, scaffold)
      } catch (error) {
        if (!redoMountedRef.current || generation !== redoGenerationRef.current || sessionId !== expectedSessionId) return
        setRedoScaffoldError(error instanceof Error ? error.message : '关键信息获取失败，请重试。')
      } finally {
        redoScaffoldRequestInFlightRef.current = false
        if (redoMountedRef.current && generation === redoGenerationRef.current) setRedoScaffoldLoading(false)
      }
      return
    }
    if (redoListeningLevel === 2) {
      setRedoListeningLevel(3)
      return
    }
    if (redoListeningLevel === 3) setRedoListeningLevel(4)
   }

  const startRedoRecording = async () => {
    if (redoStartLockRef.current || !redoMountedRef.current || !feedbackData) return
    redoStartLockRef.current = true
    const generation = ++redoGenerationRef.current
    const expectedSessionToken = scenario.sessionToken
    const expectedSessionId = sessionId
    const expectedTurn = feedbackData.redoTask.turn
    setRedoError('')
    if (!config?.elevenlabs.sttAvailable) {
      setRedoInputMode('text')
      setRedoState('confirming')
      redoStartLockRef.current = false
      return
    }
    try {
      const token = await requestElevenLabsToken('realtime_scribe')
      if (!redoMountedRef.current || generation !== redoGenerationRef.current || !feedbackData || sessionId !== expectedSessionId || scenario.sessionToken !== expectedSessionToken || feedbackData.redoTask.turn !== expectedTurn) return
      const session = new RealtimeSttSession()
      redoSttRef.current = session
      setRedoTranscript('')
      setRedoState('recording')
      await session.start(token, config.elevenlabs.sttModel, {
        onPartial: (text) => {
          if (redoMountedRef.current && generation === redoGenerationRef.current) setRedoTranscript(text)
        },
        onConnectionState: () => {},
        onAudioLevel: () => {},
      })
    } catch (error) {
      if (!redoMountedRef.current || generation !== redoGenerationRef.current) return
      redoSttRef.current?.close()
      redoSttRef.current = null
      setRedoInputMode('text')
      setRedoState('confirming')
      setRedoError(error instanceof Error ? error.message : '麦克风不可用，已切换为文字输入。')
    } finally {
      if (generation === redoGenerationRef.current) redoStartLockRef.current = false
    }
  }

  const stopRedoRecording = async () => {
    const session = redoSttRef.current
    if (!session) return
    const generation = redoGenerationRef.current
    try {
      const rawText = await session.stop()
      if (redoMountedRef.current && generation === redoGenerationRef.current) setRedoTranscript(cleanTranscript(rawText).cleanedText)
    } finally {
      session.close()
      if (redoSttRef.current === session) redoSttRef.current = null
      if (redoMountedRef.current && generation === redoGenerationRef.current) setRedoState('confirming')
    }
  }

  const confirmRedo = () => {
    if (redoSubmitLockRef.current || !redoMountedRef.current || !feedbackData || !redoTranscript.trim()) {
      if (!redoSubmitLockRef.current && feedbackData && !redoTranscript.trim()) setRedoError('回答不能为空，请修改或重新录音。')
      return
    }
    redoSubmitLockRef.current = true
    setRedoState('loading')
    setRedoError('')
    onRequestRedo({
      scenarioType: 'dynamic', sessionToken: scenario.sessionToken, turn: feedbackData.redoTask.turn,
      partnerPromptJa: feedbackData.redoTask.partnerPromptJa, firstConfirmedJa: feedbackData.redoTask.firstConfirmedJa,
      secondConfirmedJa: redoTranscript.trim(), secondInputMode: redoInputMode,
      secondListeningScaffoldLevel: redoListeningLevel, secondExpressionScaffoldLevel: redoExpressionLevel,
    })
    redoSubmitLockRef.current = false
  }

  const outcomeLabel: Record<ConversationFeedbackResponse['outcome'], string> = {
    completed: '目标完成',
    partial: '部分完成',
    not_completed: '目标未完成',
    insufficient_evidence: '证据不足',
  }

  return (
    <div className="complete-view">
      <p className="brand-mark">复盘</p>
      <h1 id="conversation-heading">{reveal.titleZh}</h1>
      <p className="reveal-summary">{reveal.summaryZh}</p>
      {audioNotice && <p className="network-notice" role="status">{audioNotice}</p>}
      {practiceComparison && feedbackStatus === 'success' && <section className="practice-comparison" aria-labelledby="practice-comparison-heading">
        <h2 id="practice-comparison-heading">本场景表现</h2>
        {practiceComparison.current.validEvaluation ? <>
          <p>{practiceComparison.baselineAttempt
            ? `与 ${new Date(practiceComparison.baselineAttempt.report.startedAt).toLocaleDateString('zh-CN')} 的首次完整有效练习比较。`
            : report.completion.closedNaturally ? '已记录本次表现。再次完整练习同一场景后，可与首次有效记录比较。' : '本次提前结束，仅展示已观察到的表现。'}</p>
          <details className="practice-details">
            <summary>查看详细统计</summary>
            <table className="practice-comparison-table">
              <thead><tr><th scope="col">沟通证据点</th>{practiceComparison.baseline && <th scope="col">首次</th>}<th scope="col">本次</th></tr></thead>
              <tbody>
                <tr><th scope="row">已完成</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.completed}/{practiceComparison.baseline.total}</td>}<td>{practiceComparison.current.completed}/{practiceComparison.current.total}</td></tr>
                <tr><th scope="row">听力未查看帮助</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.listeningIndependent}</td>}<td>{practiceComparison.current.listeningIndependent}</td></tr>
                <tr><th scope="row">表达未查看帮助</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.expressionIndependent}</td>}<td>{practiceComparison.current.expressionIndependent}</td></tr>
                <tr><th scope="row">独立性证据不足</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.independenceUnknown}</td>}<td>{practiceComparison.current.independenceUnknown}</td></tr>
              </tbody>
            </table>
            <p className="practice-storage-note">帮助统计仅针对已完成的证据点。编辑、重录、文字输入、音频证据缺失，或无法排除先前表达帮助的影响时，独立性保留为证据不足。</p>
            <p className="practice-storage-note">本次未观察 {practiceComparison.current.notObserved} 项，完成情况证据不足 {practiceComparison.current.insufficientEvidence} 项。原场景复练反映熟练情况，不代表整体日语水平。</p>
          </details>
        </> : <p>本次缺少可比较的评价证据，保留对话事实与复盘。</p>}
        {scenario.dynamicData.evidencePoints && feedbackData?.evidenceResults && <ul className="practice-evidence-list">
          {scenario.dynamicData.evidencePoints.map((point) => {
            const result = feedbackData.evidenceResults?.find((item) => item.pointId === point.id)
            const labels = { completed: '已完成', not_completed: '未完成', not_observed: '未观察', insufficient_evidence: '证据不足' }
            return <li key={point.id}><strong>{point.titleZh}</strong><span>{result ? labels[result.status] : '证据不足'}</span>
              {result?.evidence.map((item, index) => <p key={`${item.turn}-${index}`} lang="ja">第 {item.turn} 轮：「{item.quoteJa}」</p>)}
            </li>
          })}
        </ul>}
      </section>}

      {feedbackStatus === 'loading' && <div className="feedback-loading-card"><span className="pulse-dot" /><p>正在整理本场反馈...</p></div>}
      {feedbackStatus === 'error' && <div className="feedback-error-card" role="alert"><p>{feedbackErrorMsg}</p><button className="primary-button" type="button" onClick={onRetryFeedback}>重新生成</button></div>}
      {feedbackStatus === 'success' && feedbackData && (
        <div className="feedback-content">
          <section className="feedback-section goal-summary-card"><h2>这次收获</h2><p><strong>{outcomeLabel[feedbackData.outcome]}</strong></p></section>
          <section className="feedback-section"><h2>做到这一点的证据</h2><p>{feedbackData.outcomeEvidenceZh}</p></section>
          <section className="feedback-section"><h2>听力收获</h2>{feedbackData.listeningFinding ? <><p>第 {feedbackData.listeningFinding.turn} 轮：{feedbackData.listeningFinding.findingZh}</p><p>{feedbackData.listeningFinding.evidenceZh}</p></> : <p>本场没有足够证据形成听力发现。</p>}</section>
          <section className="feedback-section"><h2>下次可以这样说</h2>{feedbackData.expressionImprovement ? <><p lang="ja">{feedbackData.expressionImprovement.userConfirmedJa}</p><p lang="ja">建议：{feedbackData.expressionImprovement.suggestedJa}</p><p>{feedbackData.expressionImprovement.reasonZh}</p></> : <p>本场没有必须改写的表达。</p>}</section>
          <section className="feedback-section retry-task-card">
            <h2>再练一个关键回合</h2>
            <p lang="ja"><strong>这次回答：</strong>{feedbackData.redoTask.firstConfirmedJa}</p>
            {redoState === 'idle' && <div className="retry-actions"><button className="primary-button" type="button" onClick={startRedo}><Volume2 size={16} /> 再练这个回合</button></div>}
            {redoState === 'ready' && <div className="retry-actions"><button className="primary-button" type="button" onClick={() => void startRedoRecording()}><Mic size={16} /> 开始回答</button><button className="text-button" type="button" onClick={() => { setRedoInputMode('text'); setRedoState('confirming') }}>改用文字</button></div>}
            {(redoState === 'ready' || redoState === 'recording' || redoState === 'confirming') && (
              <div className="retry-scaffold" aria-live="polite">
                <div className="retry-scaffold-status">
                  <strong>{LISTENING_LEVEL_LABELS[redoListeningLevel]}</strong>
                  <span>{nextListeningAction(redoListeningLevel) ?? '已显示全部帮助'}</span>
                </div>
                <div className="retry-actions">
                  <button className="text-button" type="button" onClick={() => { onReplayAi(feedbackData.redoTask.partnerPromptJa); setRedoListeningLevel((level) => level < 1 ? 1 : level) }}>从头重听</button>
                  {nextListeningAction(redoListeningLevel) && redoListeningLevel > 0 && (
                    <button className="secondary-button" type="button" disabled={redoScaffoldLoading} onClick={() => void advanceRedoListeningScaffold()}>
                      {redoScaffoldLoading ? '正在获取关键信息…' : nextListeningAction(redoListeningLevel)}
                    </button>
                  )}
                  <button className="text-button" type="button" onClick={() => setRedoExpressionLevel((level) => level === 4 ? 4 : (level + 1) as 1 | 2 | 3 | 4)}>再多给一点表达帮助</button>
                </div>
                {redoScaffoldError && <p className="im-listening-error" role="alert">{redoScaffoldError} 未显示新帮助，可重试。</p>}
                {redoListeningLevel >= 2 && effectiveRedoScaffold && (
                  <div className="retry-scaffold-reveal is-hint">
                    <strong>关键信息</strong>
                    <p>{effectiveRedoScaffold.keyInformationHintZh}</p>
                    <p lang="ja">原文线索：{effectiveRedoScaffold.keyPhrasesJa.join(' / ')}</p>
                  </div>
                )}
                {redoListeningLevel >= 3 && (
                  <div className="retry-scaffold-reveal">
                    <strong>日语台词</strong>
                    <p lang="ja">{feedbackData.redoTask.partnerPromptJa}</p>
                  </div>
                )}
                {redoListeningLevel >= 4 && effectiveRedoScaffold && (
                  <div className="retry-scaffold-reveal is-intent">
                    <strong>这句话想表达</strong>
                    <p>{effectiveRedoScaffold.intentSummaryZh}</p>
                  </div>
                )}
              </div>
            )}
            {redoState === 'recording' && <div className="retry-recording-panel"><p lang="ja">{redoTranscript || '请开始说话'}</p><button className="primary-button" type="button" onClick={() => void stopRedoRecording()}>说完了，确认转写</button></div>}
            {redoExpressionLevel > 0 && redoState !== 'complete' && <p><strong>表达方向：</strong>{feedbackData.redoTask.directionZh}</p>}
            {redoState === 'confirming' && <div className="retry-confirming-panel"><label htmlFor="redo-confirmed"><strong>确认这次回答：</strong></label><textarea id="redo-confirmed" className="retry-textarea" lang="ja" value={redoTranscript} onChange={(event) => setRedoTranscript(event.target.value)} /><div className="retry-confirm-buttons"><button className="secondary-button" type="button" onClick={() => void startRedoRecording()}>重新录音</button><button className="primary-button" type="button" onClick={() => void confirmRedo()}>确认回答并查看比较</button></div></div>}
            {redoState === 'loading' && <div className="retry-confirming-panel">
              <label htmlFor="redo-confirmed"><strong>已提交的回答：</strong></label>
              <textarea id="redo-confirmed" className="retry-textarea" lang="ja" value={redoTranscript} readOnly aria-readonly="true" />
              <p>正在比较两次回答…</p>
            </div>}
            {redoError && <p className="inline-error" role="alert">{redoError}</p>}
            {redoState === 'complete' && redoResult && <div className="retry-completed-panel"><p>{redoResult.comparisonZh}</p><p lang="ja"><strong>参考表达：</strong>{redoResult.referenceExpressionJa}</p><button className="text-button" type="button" onClick={startRedo}>再做一次</button></div>}
          </section>
        </div>
      )}

      <details className="developer-disclosure">
        <summary>开发信息</summary>
        <p>会话 {messages.length} 条消息，{rounds.length} 个原始回合，{report.redos.length} 个重做记录。</p>
        <div className="developer-actions"><button className="secondary-button" type="button" onClick={onCopy}>复制 JSON</button><button className="text-button" type="button" onClick={onDownload}>下载 JSON</button>{copyStatus && <span role="status">{copyStatus}</span>}</div>
      </details>
      {historyNotice && <p role="status" className="practice-storage-note">{historyNotice}</p>}
      {onRetrySave && <button className="secondary-button" type="button" onClick={onRetrySave}>重试保存</button>}
      <div className="complete-actions">
        {onRepeatScenario && <button className="primary-button" type="button" onClick={onRepeatScenario}>再练这个场景</button>}
        <button className="secondary-button" type="button" onClick={onNewScenario}>开始新场景</button>
      </div>
    </div>
  )
}
