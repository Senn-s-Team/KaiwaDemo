/**
 * [INPUT]: 场景草拟 durable task handlers 与 typed Workflow adapter
 * [OUTPUT]: 验证幂等提交、状态终止、能力鉴权与过期行为
 * [POS]: tests/worker 的 durable task seam 契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { signScenarioDraftCapability, verifyScenarioDraftCapability } from '../../worker/tokens'
import { getScenarioDraftTaskStatus, handleScenarioDraftGet, handleScenarioDraftPost, submitScenarioDraftTask } from '../../worker/scenario-draft-task'
import { ScenarioDraftTaskRequestSchema } from '../../shared/scenario-draft'
import type { Env } from '../../worker/env'

class FakeWorkflowInstance {
  readonly id: string
  private readonly current: { status: string; output?: unknown }
  constructor(id: string, current: { status: string; output?: unknown }) { this.id = id; this.current = current }
  async status() { return this.current }
}
class FakeWorkflow {
  readonly instances = new Map<string, FakeWorkflowInstance>()
  creates = 0
  async create(options: { id?: string }) {
    if (!options.id || this.instances.has(options.id)) throw new Error('already exists')
    this.creates += 1
    const instance = new FakeWorkflowInstance(options.id, { status: 'queued' })
    this.instances.set(options.id, instance)
    return instance
  }
  async get(id: string) {
    const instance = this.instances.get(id)
    if (!instance) throw new Error('not found')
    return instance
  }
}
class FailingWorkflow {
  async create(): Promise<never> { throw new Error('sentinel-secret') }
  async get(): Promise<never> { throw new Error('sentinel-secret') }
}

const workflow = new FakeWorkflow()
const env: Env = { SCENARIO_SIGNING_SECRET: 'test-secret', SCENARIO_DRAFT: workflow }
const unconfiguredEnv: Env = { SCENARIO_SIGNING_SECRET: 'test-secret' }
const createdAt = Date.now()
const parsedRequest = ScenarioDraftTaskRequestSchema.parse({ requestId: '11111111-1111-4111-8111-111111111111', createdAt, inputZh: '在咖啡店点单', clarifications: [], forceGenerate: false })
const request = (overrides: Record<string, unknown> = {}) => new Request('https://kaiwa.example/api/scenario/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', createdAt, inputZh: '在咖啡店点单', clarifications: [], forceGenerate: false, ...overrides }) })
const post = (body: Request) => handleScenarioDraftPost(body, env)
beforeEach(() => {
  workflow.instances.clear()
  workflow.creates = 0
})

describe('durable scenario draft task', () => {
  it('reports an unconfigured Workflow as 503 when submitting', async () => {
    await expect(submitScenarioDraftTask(unconfiguredEnv, parsedRequest)).rejects.toMatchObject({ code: 'workflow_unconfigured', status: 503 })
    const response = await handleScenarioDraftPost(request(), unconfiguredEnv)
    expect(response.status).toBe(503)
  })

  it('reports an unconfigured Workflow as 503 when querying', async () => {
    const taskToken = await signScenarioDraftCapability(env, 'missing-workflow-task', Date.now() + 60_000)
    await expect(getScenarioDraftTaskStatus(unconfiguredEnv, taskToken)).rejects.toMatchObject({ code: 'workflow_unconfigured', status: 503 })
    const response = await handleScenarioDraftGet(new Request('https://kaiwa.example/api/scenario/draft', { headers: { authorization: `Bearer ${taskToken}` } }), unconfiguredEnv)
    expect(response.status).toBe(503)
  })

  it('replays the same envelope without creating a second instance', async () => {
    const first = await post(request())
    const second = await post(request())
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(workflow.creates).toBe(1)
    const firstBody = await first.json() as { taskToken: string }
    const secondBody = await second.json() as { taskToken: string }
    const firstCapability = await verifyScenarioDraftCapability(env, firstBody.taskToken)
    const secondCapability = await verifyScenarioDraftCapability(env, secondBody.taskToken)
    expect(firstCapability.taskId).toBe(secondCapability.taskId)
  })

  it('coalesces concurrent submissions of one exact envelope', async () => {
    const [first, second] = await Promise.all([post(request({ requestId: '55555555-5555-4555-8555-555555555555' })), post(request({ requestId: '55555555-5555-4555-8555-555555555555' }))])
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(workflow.creates).toBe(1)
    const firstBody = await first.json() as { taskToken: string }
    const secondBody = await second.json() as { taskToken: string }
    const firstCapability = await verifyScenarioDraftCapability(env, firstBody.taskToken)
    const secondCapability = await verifyScenarioDraftCapability(env, secondBody.taskToken)
    expect(secondCapability.taskId).toBe(firstCapability.taskId)
  })
  it('returns pending for queued tasks and rejects missing or invalid capabilities', async () => {
    const accepted = await post(request({ requestId: '22222222-2222-4222-8222-222222222222' }))
    const acceptedBody = await accepted.json() as { taskToken: string }
    const token = acceptedBody.taskToken
    const status = await handleScenarioDraftGet(new Request('https://kaiwa.example/api/scenario/draft', { headers: { authorization: `Bearer ${token}` } }), env)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ status: 'pending' })
    const invalid = await handleScenarioDraftGet(new Request('https://kaiwa.example/api/scenario/draft', { headers: { authorization: 'Bearer nope' } }), env)
    expect(invalid.status).toBe(401)
  })

  it('sanitizes unexpected Workflow binding errors', async () => {
    const failingEnv = { ...env, SCENARIO_DRAFT: new FailingWorkflow() } as unknown as Env
    const response = await handleScenarioDraftPost(request({ requestId: '44444444-4444-4444-8444-444444444444' }), failingEnv)
    const body = await response.json() as { error?: { message?: string } }
    expect(response.status).toBe(503)
    expect(body.error?.message).not.toContain('sentinel-secret')
  })
  it('rejects expired envelopes before scheduling', async () => {
    const response = await post(request({ requestId: '33333333-3333-4333-8333-333333333333', createdAt: Date.now() - 86_400_001 }))
    expect(response.status).toBe(410)
    expect(workflow.creates).toBe(0)
  })
})
