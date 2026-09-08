/**
 * [INPUT]: 依赖 zod 定义场景设置中文描述润色的跨端线协议
 * [OUTPUT]: 对外提供 ScenarioPolishRequestSchema、ScenarioPolishResponseSchema 及其推导类型
 * [POS]: shared 的场景描述润色 wire contract 唯一来源，约束可编辑的保真润色输入与输出
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

const ScenarioTextSchema = z.string().trim().min(1).max(300)

export const ScenarioPolishRequestSchema = z.object({ textZh: ScenarioTextSchema }).strict()
export const ScenarioPolishResponseSchema = z.object({ textZh: ScenarioTextSchema }).strict()

export type ScenarioPolishRequest = z.infer<typeof ScenarioPolishRequestSchema>
export type ScenarioPolishResponse = z.infer<typeof ScenarioPolishResponseSchema>
