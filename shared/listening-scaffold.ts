/**
 * [INPUT]: 依赖 zod 定义跨前端与 Worker 的四级听力支架线协议
 * [OUTPUT]: 对外提供 ListeningScaffoldRequestSchema、ListeningScaffoldResponseSchema 及其推导类型
 * [POS]: shared 的 listening-scaffold wire contract 唯一来源，统一关键信息、原文短语与意图概要
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

export const ListeningScaffoldRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().min(1),
  turn: z.number().int().min(1).max(5),
  partnerPromptJa: z.string().trim().min(1).max(120),
}).strict()

export const ListeningScaffoldResponseSchema = z.object({
  keyInformationHintZh: z.string().trim().min(1).max(120),
  keyPhrasesJa: z.array(z.string().trim().min(1).max(30)).min(1).max(4),
  intentSummaryZh: z.string().trim().min(1).max(120),
}).strict()

export type ListeningScaffoldRequest = z.infer<typeof ListeningScaffoldRequestSchema>
export type ListeningScaffoldResponse = z.infer<typeof ListeningScaffoldResponseSchema>
