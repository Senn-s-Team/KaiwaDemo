# worker/
> L2 | 父级: /AGENTS.md
成员清单
index.ts: Cloudflare Worker 入口与 API 路由编排，统一同源校验、请求解析、模型调用和响应边界，包括 POST /api/listening-scaffold
openai.ts: OpenAI Responses 适配层，承载动态场景、相手回复、表达支架、四级听力支架、复盘、重做与语音辅助生成
scenarios.ts: 动态五回合场景的提示词构建，维护角色、事实、目标、表达支架、受限上下文听力支架、反馈与收束语义
validation.ts: Worker 入站与模型出站数据校验，执行严格 schema、跨字段约束、听力关键语块原文子串校验和安全规整
types.ts: 除 shared/ 唯一 wire contract 外的 Worker 动态场景、会话、回复、表达支架与反馈领域载荷
mock.ts: 无外部模型时的受控动态会话、反馈、重做、四级听力支架与语音辅助回退行为
tokens.ts: 场景与会话令牌的 HMAC 签发、验签、过期和载荷边界
constants.ts: 五回合预算、请求限额、模型默认值与全局相手安全约束
env.ts: Worker secrets、模型和 Mock 开关的环境绑定类型
elevenlabs.ts: ElevenLabs STT/TTS 临时令牌代理与上游错误归一化
http.ts: JSON 响应、请求体限制、方法和同源校验等 HTTP 边界工具

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
