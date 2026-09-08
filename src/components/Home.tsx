/**
 * [INPUT]: 首页场景草稿 view model、中文语音识别/可取消润色动作与结构化本机练习历史
 * [OUTPUT]: 渲染首页场景准备、澄清、实时中文语音输入、可撤回润色与示例入口
 * [POS]: src/components 的首页纯视图；不拥有任务持久化或场景会话编排
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { ArrowRight, Mic } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { polishScenarioText, requestElevenLabsToken } from '../lib/api'
import { releaseMicrophoneStream, shouldTeardownOnVisibility } from '../lib/audio-engine'
import { appendHomeSttText, shouldApplyHomeSttResult, shouldCancelHomeSttForTransition } from '../lib/home-stt'
import { coordinateRecordingSetup } from '../lib/recording-setup'
import type { ScenarioDraftRecoveryState } from '../lib/scenario-draft-task'
import { buildSparkPrompt, drawPracticeExamples } from '../lib/spark-practice'
import { RealtimeSttSession } from '../lib/stt'
import type { DynamicScenarioData, UiError } from '../types'
import type { StoredPracticeAttempt } from '../lib/practice-history'

interface HomeProps {
  loading: boolean
  ready: boolean
  online: boolean
  error: UiError | null
  sttAvailable: boolean
  sttModel: string
  customInputZh: string
  setCustomInputZh: React.Dispatch<React.SetStateAction<string>>
  clarifications: Array<{ questionZh: string; answerZh: string }>
  pendingClarification: { questionZh: string; optionsZh: readonly string[] } | null
  readyScenarioData: { scenario: DynamicScenarioData; scenarioToken: string } | null
  isDraftingScenario: boolean
  onDraftScenario: (prompt?: string, clarifications?: Array<{ questionZh: string; answerZh: string }>, force?: boolean) => void
  onAnswerClarification: (answer: string) => void
  onStartDynamic: (scenarioToken: string) => void
  onResetCustom: () => void
  recentPractices: StoredPracticeAttempt[]
  practiceHistory: StoredPracticeAttempt[]
  historyNotice: string
  historySaving: boolean
  onPreparePractice: (attempt: StoredPracticeAttempt) => void
  onRemovePractice: (attempt: StoredPracticeAttempt) => void
  draftState: ScenarioDraftRecoveryState
  onRetryDraftTransport: () => void
  onInputEdited: () => void
}

export function Home({
  loading, ready, online, error, sttAvailable, sttModel, customInputZh, setCustomInputZh,
  clarifications, pendingClarification, readyScenarioData, isDraftingScenario,
  onDraftScenario, onAnswerClarification, onStartDynamic, onResetCustom, recentPractices, practiceHistory, historyNotice, historySaving, onPreparePractice, onRemovePractice, draftState, onRetryDraftTransport, onInputEdited,
}: HomeProps): React.JSX.Element {
  const [clarificationInput, setClarificationInput] = useState('')
  const [examples, setExamples] = useState(() => drawPracticeExamples())
  const topicInputRef = useRef<HTMLTextAreaElement>(null)
  const [homeSttState, setHomeSttState] = useState<'idle' | 'connecting' | 'recording' | 'stopping' | 'polishing'>('idle')
  const [homeSttText, setHomeSttText] = useState('')
  const [homeSttError, setHomeSttError] = useState('')
  const [homeSttAudioLevel, setHomeSttAudioLevel] = useState(0)
  const homeSttRef = useRef<RealtimeSttSession | null>(null)
  const homeSttAbortRef = useRef<AbortController | null>(null)
  const homeSttGenerationRef = useRef(0)
  const homeSttBaseRef = useRef('')
  const homePolishAbortRef = useRef<AbortController | null>(null)
  const homePolishGenerationRef = useRef(0)
  const homePolishOriginalRef = useRef('')
  const [homePolishAvailable, setHomePolishAvailable] = useState(false)
  const busy = loading || isDraftingScenario
  const unavailable = busy || !ready || !online

  const cancelHomeStt = useCallback(() => {
    homeSttGenerationRef.current += 1
    homePolishGenerationRef.current += 1
    homePolishAbortRef.current?.abort()
    homePolishAbortRef.current = null
    homeSttRef.current?.close()
    homeSttRef.current = null
    homeSttAbortRef.current?.abort()
    homeSttAbortRef.current = null
    releaseMicrophoneStream()
    homeSttBaseRef.current = ''
    homeSttTextRef.current = ''
    setHomeSttText('')
    setHomeSttAudioLevel(0)
    setHomeSttState('idle')
    setHomePolishAvailable(false)
  }, [])

  const cancelHomePolish = useCallback(() => {
    homePolishGenerationRef.current += 1
    homePolishAbortRef.current?.abort()
    homePolishAbortRef.current = null
    setHomePolishAvailable(false)
    setHomeSttState('idle')
  }, [])

  const homeSttTextRef = useRef('')

  useEffect(() => cancelHomeStt, [cancelHomeStt])

  useEffect(() => {
    const stopForPageExit = () => cancelHomeStt()
    const stopForBackground = () => {
      if (document.visibilityState === 'hidden' && shouldTeardownOnVisibility(document.hidden)) cancelHomeStt()
    }
    window.addEventListener('pagehide', stopForPageExit)
    document.addEventListener('visibilitychange', stopForBackground)
    return () => {
      window.removeEventListener('pagehide', stopForPageExit)
      document.removeEventListener('visibilitychange', stopForBackground)
    }
  }, [cancelHomeStt])

  useEffect(() => {
    if (shouldCancelHomeSttForTransition(Boolean(readyScenarioData), Boolean(pendingClarification), busy)) cancelHomeStt()
  }, [busy, cancelHomeStt, pendingClarification, readyScenarioData])
  const startHomeStt = useCallback(async () => {
    if (!sttAvailable || !sttModel || homeSttState !== 'idle' || readyScenarioData || pendingClarification || busy) return
    const generation = ++homeSttGenerationRef.current
    const session = new RealtimeSttSession()
    let controller: AbortController | null = null
    homeSttRef.current = session
    setHomeSttError('')
    setHomePolishAvailable(false)
    setHomeSttText('')
    homeSttTextRef.current = ''
    homeSttBaseRef.current = customInputZh
    setHomeSttAudioLevel(0)
    setHomeSttState('connecting')
    try {
      const startController = new AbortController()
      controller = startController
      homeSttAbortRef.current = startController
      await coordinateRecordingSetup({
        acquireToken: () => requestElevenLabsToken('realtime_scribe', startController.signal),
        isCancelled: () => startController.signal.aborted || generation !== homeSttGenerationRef.current,
        releaseOnCancelled: false,
        connectStt: (token) => session.start(token, sttModel, {
        onPartial: (text) => {
          if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) {
            if (!homeSttTextRef.current.trim()) onInputEdited()
            homeSttTextRef.current = text
            setHomeSttText(text)
            const merged = appendHomeSttText(homeSttBaseRef.current, text)
            if (merged.applied) setCustomInputZh(merged.text)
            else setHomeSttError('输入框已接近 300 字，未写入本次识别结果；原有内容已保留。')
          }
        },
        onConnectionState: (state) => {
          if (state === 'connected' && shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) setHomeSttState('recording')
        },
        onAudioLevel: (level) => {
          if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) setHomeSttAudioLevel(Math.min(1, Math.max(0, level)))
        },
        }, 'zh'),
      })
      if (homeSttAbortRef.current === controller) homeSttAbortRef.current = null
    } catch (error) {
      if (homeSttAbortRef.current === controller) homeSttAbortRef.current = null
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) {
        setHomeSttError(error instanceof Error ? error.message : '中文识别暂时无法启动，请改为输入文字。')
        cancelHomeStt()
      }
    }
  }, [busy, cancelHomeStt, customInputZh, homeSttState, onInputEdited, pendingClarification, readyScenarioData, setCustomInputZh, sttAvailable, sttModel])

  const stopHomeStt = useCallback(async () => {
    const session = homeSttRef.current
    const generation = homeSttGenerationRef.current
    if (!session || homeSttState !== 'recording') return
    setHomeSttState('stopping')
    try {
      const recognized = await session.stop()
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden) && recognized.trim()) {
        onInputEdited()
        const baseText = homeSttBaseRef.current
        const merged = appendHomeSttText(baseText, recognized)
        if (!merged.applied) {
          setHomeSttError('输入框已接近 300 字，未写入本次识别结果；原有内容已保留。')
          return
        }
        setCustomInputZh(merged.text)

        // 识别完成即释放硬件；润色是纯网络任务，绝不能继续占用麦克风。
        session.close()
        if (homeSttRef.current === session) homeSttRef.current = null
        homeSttAbortRef.current = null
        releaseMicrophoneStream()
        homeSttBaseRef.current = ''
        homeSttTextRef.current = ''
        setHomeSttText('')
        setHomeSttAudioLevel(0)
        setHomeSttState('polishing')

        const polishGeneration = ++homePolishGenerationRef.current
        const controller = new AbortController()
        homePolishAbortRef.current = controller
        try {
          const polished = await polishScenarioText(recognized.trim(), controller.signal)
          if (polishGeneration !== homePolishGenerationRef.current || generation !== homeSttGenerationRef.current || controller.signal.aborted || document.hidden) return
          const polishedMerged = appendHomeSttText(baseText, polished)
          if (!polishedMerged.applied) return
          homePolishOriginalRef.current = merged.text
          setCustomInputZh(polishedMerged.text)
          setHomePolishAvailable(true)
        } catch {
          if (polishGeneration === homePolishGenerationRef.current && generation === homeSttGenerationRef.current && !controller.signal.aborted && !document.hidden) {
            setHomeSttError('润色暂时失败，已保留原识别内容。')
          }
        } finally {
          if (polishGeneration === homePolishGenerationRef.current) {
            homePolishAbortRef.current = null
            if (generation === homeSttGenerationRef.current) setHomeSttState('idle')
          }
        }
      }
    } catch (error) {
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) {
        setHomeSttError(error instanceof Error ? error.message : '中文识别失败，已保留原有内容。')
      }
    } finally {
      // stop 出错、空文本和过期操作仍在此结束录音；正常识别已在润色前释放。
      if (homeSttRef.current === session) {
        session.close()
        homeSttRef.current = null
        homeSttAbortRef.current = null
        releaseMicrophoneStream()
        homeSttBaseRef.current = ''
        homeSttTextRef.current = ''
        setHomeSttText('')
        setHomeSttAudioLevel(0)
        if (generation === homeSttGenerationRef.current) setHomeSttState('idle')
      }
    }
  }, [homeSttState, onInputEdited, setCustomInputZh])

  const skipHomePolish = useCallback(() => {
    homeSttGenerationRef.current += 1
    homePolishGenerationRef.current += 1
    homePolishAbortRef.current?.abort()
    homePolishAbortRef.current = null
    setHomeSttState('idle')
    setHomePolishAvailable(false)
  }, [])


  return (
    <div className="intro-block home-launch-layout">
      <header className="home-header">
        <h1 id="conversation-heading">今天想练哪段日语对话？</h1>
        <p className="home-subtitle">写下一个场景，或一件你想说清楚的事。</p>
      </header>
      {error && <div className="error-panel" role="alert"><div><p className="error-title">{error.title}</p><p>{error.message}</p></div></div>}
      {readyScenarioData ? (
        <section className="ready-scenario-card" aria-labelledby="ready-scenario-title">
          <p className="ready-badge">准备好了</p>
          <h2 id="ready-scenario-title">{readyScenarioData.scenario.titleZh}</h2>
          <p className="ready-desc">{readyScenarioData.scenario.summaryZh}</p>
          <div className="ready-meta">
            <p><strong>你是：</strong>{readyScenarioData.scenario.userRole}</p>
            <p><strong>对方是：</strong>{readyScenarioData.scenario.aiRole}</p>
          </div>
          <div className="ready-goal"><strong>这次想做到</strong><p>{readyScenarioData.scenario.coreGoal.descriptionZh}</p></div>
          <div className="ready-actions">
            <button className="primary-button" type="button" onClick={() => { cancelHomeStt(); onStartDynamic(readyScenarioData.scenarioToken) }} disabled={unavailable}>开始对话 <ArrowRight size={18} aria-hidden="true" /></button>
            <button className="text-button" type="button" onClick={() => { cancelHomeStt(); onResetCustom() }} disabled={busy}>修改描述</button>
          </div>
          <p className="session-length">最多五轮，也可随时提前复盘。</p>
          {draftState.storageNotice && <p className="session-length" role="status">{draftState.storageNotice}</p>}
        </section>
      ) : (
        <>
          <form className="custom-scenario-box" aria-busy={isDraftingScenario} onSubmit={(event) => { event.preventDefault(); if (!unavailable && homeSttState === 'idle' && customInputZh.trim() && !pendingClarification) { cancelHomeStt(); onDraftScenario() } }}>
            <label className="visually-hidden" htmlFor="custom-topic-input">想练习的场景</label>
            <textarea ref={topicInputRef} id="custom-topic-input" className="custom-textarea" rows={3} maxLength={300} aria-describedby="topic-help topic-count" placeholder="比如：明天去剪头发，想说明剪短一点，但不要露出额头。" value={customInputZh} readOnly={homeSttState === 'connecting' || homeSttState === 'recording' || homeSttState === 'stopping'} disabled={busy || Boolean(pendingClarification)} onChange={(event) => { onInputEdited(); cancelHomePolish(); setCustomInputZh(event.target.value) }} />
            <div className="topic-stt-row">
              {sttAvailable && <button className={`text-button home-stt-button ${homeSttState === 'recording' ? 'is-recording' : ''}`} type="button" disabled={busy || !online || Boolean(pendingClarification) || homeSttState === 'stopping' || homeSttState === 'polishing'} onClick={() => void (homeSttState === 'connecting' ? cancelHomeStt() : homeSttState === 'idle' ? startHomeStt() : stopHomeStt())}><Mic size={16} aria-hidden="true" /> {homeSttState === 'idle' ? '中文语音输入' : homeSttState === 'connecting' ? '正在连接，取消' : homeSttState === 'stopping' ? '正在整理识别结果…' : homeSttState === 'polishing' ? '正在润色…' : '说完了'}</button>}
              {(homeSttState !== 'idle' || homeSttText || homeSttError || homePolishAvailable) && <div className="topic-stt-status" role={homeSttError ? 'alert' : 'status'}><span className="home-stt-level" style={{ '--home-stt-level': homeSttAudioLevel } as React.CSSProperties} aria-hidden="true"><i /><i /><i /><i /><i /></span><span>{homeSttError || (homeSttState === 'connecting' ? '正在连接中文语音识别…' : homeSttState === 'stopping' ? '正在整理识别结果…' : homeSttState === 'polishing' ? '正在润色，完成后可以继续手动修改。' : homeSttState === 'recording' ? '正在听你说话，文字会实时显示。' : '中文语音已填入输入框。')}</span>{homeSttState === 'polishing' && <button className="text-button" type="button" onClick={skipHomePolish}>跳过润色</button>}{homePolishAvailable && <button className="text-button" type="button" onClick={() => { setCustomInputZh(homePolishOriginalRef.current); setHomePolishAvailable(false) }}>撤回润色</button>}</div>}
            </div>
            <div className="topic-footer">
              <span id="topic-count" className="char-count">{customInputZh.length} / 300</span>
              <div className="topic-actions">
                {!pendingClarification && <button className="primary-button" type="submit" disabled={!customInputZh.trim() || unavailable || homeSttState !== 'idle'}>{isDraftingScenario ? '正在准备…' : '准备练习'} <ArrowRight size={18} aria-hidden="true" /></button>}
              </div>
            </div>
            {draftState.status === 'submitting' || draftState.status === 'pending' ? (
              <p className="topic-stt-status" role="status">{draftState.storageNotice || '正在准备，可以暂时离开；回来后会继续显示结果。'}</p>
            ) : null}
            {draftState.status === 'transport_error' ? (
              <p className="topic-stt-status" role="status">连接暂时中断，恢复后会继续。{draftState.error} <button className="text-button" type="button" onClick={onRetryDraftTransport}>现在重试</button></p>
            ) : null}
            {draftState.status === 'failed' || draftState.status === 'expired' ? (
              <p className="topic-stt-status" role="alert">{draftState.error} <button className="text-button" type="button" onClick={() => onDraftScenario()}>重新准备</button></p>
            ) : null}
            {draftState.status !== 'submitting' && draftState.status !== 'pending' && draftState.storageNotice ? <p className="topic-stt-status" role="status">{draftState.storageNotice}</p> : null}
            {pendingClarification && (
              <div className="clarification-panel">
                <p className="clarification-question" id="clarification-question">{pendingClarification.questionZh}</p>
                <div className="clarification-options">{pendingClarification.optionsZh.map((option) => <button key={option} className="secondary-button clarify-opt-btn" type="button" disabled={unavailable} onClick={() => { cancelHomeStt(); onAnswerClarification(option) }}>{option}</button>)}</div>
                <div className="clarify-custom-row">
                  <input className="clarify-input" aria-labelledby="clarification-question" value={clarificationInput} maxLength={300} disabled={unavailable} onChange={(event) => setClarificationInput(event.target.value)} placeholder="或者自己补充" />
                  <button className="secondary-button" type="button" disabled={!clarificationInput.trim() || unavailable} onClick={() => { cancelHomeStt(); onAnswerClarification(clarificationInput.trim()); setClarificationInput('') }}>提交</button>
                </div>
                <button className="text-button skip-clarify-btn" type="button" disabled={unavailable} onClick={() => { cancelHomeStt(); onDraftScenario(customInputZh, clarifications, true) }}>跳过，直接准备</button>
              </div>
            )}
          </form>
          <p id="topic-help" className="topic-help">中文描述即可，只写“美容院”也可以。</p>
          <section className="practice-history" aria-label="本机练习历史">
            {recentPractices.length > 0 && <><h2>最近练过</h2><ul className="practice-history-list">{recentPractices.map((attempt) => <li key={attempt.scenarioKey}><button className="practice-history-open" type="button" disabled={isDraftingScenario || !online || loading} onClick={() => onPreparePractice(attempt)}><strong>{attempt.scenario.titleZh}</strong><span>{new Date(attempt.report.startedAt).toLocaleDateString('zh-CN')} · {practiceHistory.filter((item) => item.scenarioKey === attempt.scenarioKey).length} 次练习</span></button><button className="text-button" type="button" disabled={isDraftingScenario || historySaving} onClick={() => onRemovePractice(attempt)} aria-label={`删除${attempt.scenario.titleZh}的练习记录`}>删除</button></li>)}</ul></>}
            {recentPractices.length > 0 && <p className="practice-storage-note">练习记录仅保存在当前浏览器，清理浏览器数据会删除记录。</p>}
            {historyNotice && <p role="status" className="practice-storage-note">{historyNotice}</p>}
          </section>
          {!pendingClarification && <section className="practice-examples" aria-labelledby="practice-examples-heading">
            <div className="examples-heading"><h2 id="practice-examples-heading">从一个场景开始</h2><button className="text-button" type="button" disabled={busy} onClick={() => setExamples(drawPracticeExamples(examples.map((example) => example.id)))}>换一组</button></div>
            <ul>{examples.map((example) => <li key={example.id}><button className="practice-example" type="button" disabled={busy} onClick={() => { onInputEdited(); setCustomInputZh(buildSparkPrompt(example)); topicInputRef.current?.focus() }}><span><strong>{example.challengeZh}</strong><small>{example.titleZh} · {example.domainZh}</small></span><ArrowRight size={18} aria-hidden="true" /></button></li>)}</ul>
          </section>}
        </>
      )}
    </div>
  )
}
