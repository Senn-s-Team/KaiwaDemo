/**
 * [INPUT]: 依赖 Env 配置、TokenRequest、DEADLINES 与 fetch；接收 STT/TTS 类型及可选调用方 AbortSignal
 * [OUTPUT]: 对外提供 ElevenLabs STT/TTS 临时 token 代理和上游错误归一化函数
 * [POS]: Worker 的语音供应商边界，负责临时令牌请求、上游错误映射及调用方取消与 deadline 的联合终止
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import type { Env } from './env'
import { errorJson, json } from './http'
import type { TokenRequest } from './types'
import { DEADLINES } from './constants'

const ElevenLabsErrorSchema = z.object({
  detail: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
})

interface TokenFailure {
  status: number
  code: string
  message: string
}

export function tokenFailureFromUpstream(
  upstreamStatus: number,
  payload: unknown,
  tokenType: TokenRequest['type'],
): TokenFailure {
  const parsed = ElevenLabsErrorSchema.safeParse(payload)
  const detail = parsed.success ? parsed.data.detail : undefined
  const supplierCode = `${detail?.code ?? ''} ${detail?.status ?? ''} ${detail?.type ?? ''}`.toLowerCase()
  const supplierMessage = detail?.message?.trim()
  const capability = tokenType === 'realtime_scribe' ? 'Speech to Text' : 'Text to Speech'

  if (/permission|scope|restricted/.test(`${supplierCode} ${supplierMessage ?? ''}`.toLowerCase())) {
    return {
      status: 502,
      code: 'elevenlabs_permission',
      message: `ElevenLabs API Key 缺少 ${capability} 权限。请在 ElevenLabs API Keys 中启用对应权限。`,
    }
  }
  if (/quota|credit|limit|payment/.test(`${supplierCode} ${supplierMessage ?? ''}`.toLowerCase()) || upstreamStatus === 429) {
    return {
      status: 503,
      code: 'elevenlabs_quota',
      message: `ElevenLabs 无法签发 ${capability} 临时令牌：额度、套餐或频率限制已触发。`,
    }
  }
  if (/term/.test(`${supplierCode} ${supplierMessage ?? ''}`.toLowerCase())) {
    return {
      status: 502,
      code: 'elevenlabs_terms',
      message: 'ElevenLabs 账户尚未接受使用条款，请登录供应商后台处理。',
    }
  }
  if (/invalid_api_key|authentication|unauthorized/.test(supplierCode) || upstreamStatus === 401) {
    return {
      status: 502,
      code: 'elevenlabs_auth',
      message: 'ElevenLabs API Key 无效、已撤销或已过期。请重新配置 Worker Secret。',
    }
  }

  return {
    status: upstreamStatus >= 500 ? 502 : upstreamStatus,
    code: 'elevenlabs_token_failed',
    message: supplierMessage
      ? `ElevenLabs 未签发 ${capability} 临时令牌：${supplierMessage}`
      : `ElevenLabs 未签发 ${capability} 临时令牌。请检查权限、额度和账户状态。`,
  }
}

export async function createElevenLabsToken(env: Env, request: TokenRequest, callerSignal?: AbortSignal): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) {
    return errorJson(503, 'elevenlabs_unconfigured', 'ElevenLabs is not configured for this deployment.')
  }

  const upstream = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${request.type}`, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      accept: 'application/json',
    },
    signal: AbortSignal.any([callerSignal ?? new AbortController().signal, AbortSignal.timeout(DEADLINES.elevenLabsTokenMs)]),
  })

  const payload: unknown = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    const failure = tokenFailureFromUpstream(upstream.status, payload, request.type)
    return errorJson(failure.status, failure.code, failure.message)
  }

  const tokenPayload = z.object({ token: z.string().min(10) }).safeParse(payload)
  if (!tokenPayload.success) {
    return errorJson(502, 'elevenlabs_token_invalid', 'ElevenLabs returned an invalid temporary token.')
  }

  return json({ token: tokenPayload.data.token, expiresInSeconds: 900 })
}
