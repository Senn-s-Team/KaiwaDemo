/**
 * [INPUT]: 依赖 zod 定义跨前端与 Worker 的语音续说辅助线协议
 * [OUTPUT]: 对外提供 SpeechAssistRequestSchema、SpeechAssistResponseSchema、SpeechAssistAbortReasonSchema 及其推导类型
 * [POS]: shared 的 speech-assist wire contract 唯一来源，统一请求、响应与客户端中止原因
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

export const SpeechAssistRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  transcriptVersion: z.number().int().positive(),
  observedTextJa: z.string().trim().min(1).max(600),
  lastAssistantTextJa: z.string().trim().min(1).max(120),
  trailingSilenceMs: z.number().int().min(900).max(10_000),
  sessionToken: z.string().trim().min(1),
  turn: z.number().int().min(1).max(5),
}).strict()

export const SpeechAssistResponseSchema = z.object({
  cleanedObservedTextJa: z.string().trim().min(1).max(600),
  continuationSuggestionJa: z.string().trim().min(1).max(20).nullable(),
}).strict()

export const SpeechAssistAbortReasonSchema = z.enum([
  'new_partial',
  'user_speaking',
  'recording_stopped',
  'text_input',
  'offline',
  'background',
  'stopped',
])

export type SpeechAssistRequest = z.infer<typeof SpeechAssistRequestSchema>
export type SpeechAssistResponse = z.infer<typeof SpeechAssistResponseSchema>
export type SpeechAssistAbortReason = z.infer<typeof SpeechAssistAbortReasonSchema>
