# tests/worker/
> L2 | 父级: /tests/AGENTS.md
成员清单
feedback.test.ts: 反馈请求、模型输出、证据引用与完成状态边界测试
scenarios.test.ts: 动态场景提示词与场景结构边界测试
validation.test.ts: Worker 入站与模型出站校验边界测试
scenario-polish.test.ts: 场景描述润色请求与响应边界测试
scenario-draft-task.test.ts: 场景草拟 durable task 路由与能力凭据测试
feedback-task.test.ts: 反馈 durable task 路由与能力凭据测试
dynamic-session.test.ts: 动态会话启动、回复与会话凭据流程测试
scenario-draft.test.ts: 场景草拟 wire contract 与模型结果测试
speech-assist.test.ts: 语音辅助请求、输出与固定中止原因测试
listening-scaffold.test.ts: 四级听力支架请求、输出与跨字段约束测试
openai-url.test.ts: OpenAI endpoint URL 组合边界测试
elevenlabs-token.test.ts: ElevenLabs 临时 token 代理边界测试
tokens.test.ts: Worker token 签发、验签、过期与篡改边界测试
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
