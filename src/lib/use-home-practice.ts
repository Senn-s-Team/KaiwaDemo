/**
 * [INPUT]: 首页会话活跃条件、在线状态、重置回调与 UI 错误写回
 * [OUTPUT]: 首页草稿恢复、场景准备、本机练习历史、复练、删除和串行持久化动作
 * [POS]: src/lib 的首页练习编排；复用 scenario draft recovery 作为唯一草稿轮询所有者
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { restartPractice } from './api'
import { deletePracticeScenario, listPracticeAttempts, savePracticeAttempt, type PracticeAttempt, type StoredPracticeAttempt } from './practice-history'
import { useScenarioDraftRecovery } from './scenario-draft-task'
import { toUiError } from './ui'
import type { DynamicScenarioData, UiError } from '../types'

export function useHomePractice({ online, activeSession, resetSession, setUiError }: { online: boolean; activeSession: boolean; resetSession(): void; setUiError(error: UiError | null): void }) {
  const [customInputZh, setCustomInputZh] = useState(''); const [clarifications, setClarifications] = useState<Array<{ questionZh: string; answerZh: string }>>([])
  const [pendingClarification, setPendingClarification] = useState<{ questionZh: string; optionsZh: readonly string[] } | null>(null); const [readyScenarioData, setReadyScenarioData] = useState<{ scenario: DynamicScenarioData; scenarioToken: string; practiceToken?: string } | null>(null)
  const [isRestartingPractice, setIsRestartingPractice] = useState(false); const [practiceHistory, setPracticeHistory] = useState<StoredPracticeAttempt[]>([]); const [historyNotice, setHistoryNotice] = useState(''); const [historySaving, setHistorySaving] = useState(false); const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const historyWrite = useRef<Promise<void>>(Promise.resolve()); const deletedSessions = useRef(new Set<string>()); const restartAbort = useRef<AbortController | null>(null)
  const draftRecovery = useScenarioDraftRecovery({ activeSession })
  useEffect(() => { let active = true; void listPracticeAttempts().then((attempts) => { if (active) setPracticeHistory(attempts) }).catch(() => { if (active) setHistoryNotice('无法读取本机历史，仍可开始新练习。') }); return () => { active = false; restartAbort.current?.abort() } }, [])
  useEffect(() => { const recovered = draftRecovery.state; if (!recovered.request) return; setCustomInputZh(recovered.request.inputZh); setClarifications(recovered.request.clarifications.map((item) => ({ questionZh: item.questionZh, answerZh: item.answerZh }))); if (recovered.status !== 'ready') return; if (recovered.result.status === 'needs_clarification') { setReadyScenarioData(null); setPendingClarification({ questionZh: recovered.result.questionZh, optionsZh: recovered.result.optionsZh }); return }; setPendingClarification(null); setReadyScenarioData({ scenario: recovered.result.scenario, scenarioToken: recovered.result.scenarioToken, practiceToken: recovered.result.practiceToken }) }, [draftRecovery.state])
  const isDraftingScenario = isRestartingPractice || draftRecovery.state.status === 'submitting' || draftRecovery.state.status === 'pending'
  const submitDraft = useCallback((prompt?: string, answers?: Array<{ questionZh: string; answerZh: string }>, force = false) => { const input = prompt ?? customInputZh; if (!input.trim()) return; setUiError(null); setPendingClarification(null); setReadyScenarioData(null); draftRecovery.submit(input, answers ?? clarifications, force) }, [clarifications, customInputZh, draftRecovery, setUiError])
  const answerClarification = useCallback((answer: string) => { if (!pendingClarification) return; const next = [...clarifications, { questionZh: pendingClarification.questionZh, answerZh: answer }]; setClarifications(next); setPendingClarification(null); submitDraft(undefined, next) }, [clarifications, pendingClarification, submitDraft])
  const resetCustom = useCallback(() => { draftRecovery.discard(); setClarifications([]); setPendingClarification(null); setReadyScenarioData(null) }, [draftRecovery])
  const persistPractice = useCallback((attempt: PracticeAttempt) => {
    if (deletedSessions.current.has(attempt.report.sessionId)) return Promise.resolve()
    setHistorySaving(true); setHistorySaveFailed(false)
    const pending = historyWrite.current.then(async () => { if (deletedSessions.current.has(attempt.report.sessionId)) return; await savePracticeAttempt(attempt); setPracticeHistory(await listPracticeAttempts()); setHistorySaveFailed(false); setHistoryNotice('已保存到当前浏览器。') }).catch(() => { setHistorySaveFailed(true); setHistoryNotice('本次未保存到浏览器，请重试或导出训练报告。') }).finally(() => { if (historyWrite.current === pending) setHistorySaving(false) })
    historyWrite.current = pending; return pending
  }, [])
  const recentPractices = useMemo(() => { const seen = new Set<string>(); return practiceHistory.filter((attempt) => { if (seen.has(attempt.scenarioKey)) return false; seen.add(attempt.scenarioKey); return true }) }, [practiceHistory])
  const preparePracticeAgain = useCallback(async (attempt: PracticeAttempt) => { if (!online || isDraftingScenario) return; resetSession(); setCustomInputZh(attempt.scenario.userGoal); restartAbort.current?.abort(); const controller = new AbortController(); restartAbort.current = controller; setIsRestartingPractice(true); try { const ready = await restartPractice(attempt.practiceToken, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])); if (!controller.signal.aborted) setReadyScenarioData(ready) } catch (error) { if (!controller.signal.aborted) { setUiError(toUiError(error)); setHistoryNotice('原场景暂时无法载入，可从最近练过中重试。') } } finally { if (restartAbort.current === controller) setIsRestartingPractice(false) } }, [isDraftingScenario, online, resetSession, setUiError])
  const removePractice = useCallback(async (attempt: StoredPracticeAttempt) => { if (!window.confirm(`删除“${attempt.scenario.titleZh}”及其全部本机练习记录？`)) return; await historyWrite.current; try { const deleted = practiceHistory.filter((item) => item.scenarioKey === attempt.scenarioKey).map((item) => item.report.sessionId); await deletePracticeScenario(attempt.scenarioKey); deleted.forEach((id) => deletedSessions.current.add(id)); setPracticeHistory(await listPracticeAttempts()); setHistoryNotice('已删除该场景的本机练习记录。') } catch { setHistoryNotice('删除失败，练习记录仍保留，请重试。') } }, [practiceHistory])
  return { model: { customInputZh, clarifications, pendingClarification, readyScenarioData, isDraftingScenario, draftState: draftRecovery.state, practiceHistory, recentPractices, historyNotice, historySaving, historySaveFailed }, actions: { setCustomInputZh, submitDraft, answerClarification, resetCustom, retryDraftTransport: draftRecovery.retryTransport, discardDraft: draftRecovery.discard, persistPractice, preparePracticeAgain, removePractice } }
}
