# 原型数据与隐私边界

## 训练内容与外部服务

- 用户语音会直接发送给 ElevenLabs Realtime Speech-to-Text，用于当前回答的实时转写。
- AI 日语文本会直接发送给 ElevenLabs Text-to-Speech WebSocket，用于生成当前台词语音。
- 用户确认后的转写、有限对话历史、场景信息和反馈/重做请求会通过同站点 Cloudflare Worker 发送给 OpenAI-compatible 模型服务，用于生成相手回复、提示、听力支架与会后反馈。
- OpenAI-compatible 请求设置 `store: false`，不使用 Conversations 持久化。ElevenLabs 与模型供应商自身的安全、诊断、账户日志及保留能力仍以对应账户设置、套餐和服务条款为准；本原型不承诺供应商零保留。

## 浏览器本地数据

- 当前会话恢复使用 `sessionStorage`；场景草拟和完成复盘任务恢复使用 `localStorage`；本机练习历史使用独立 IndexedDB。它们用于同一浏览器内恢复和原场景复练，不构成账号、云同步或跨设备备份。
- 本机练习历史保存完整场景、长期复练凭据、报告和反馈，但不保存原始录音、临时会话 token 或 ElevenLabs 访问 token。清除站点数据会删除这些本机记录。
- Worker 不持久化完整对话、原始录音、永久 API Key 或临时训练 token；Cloudflare Workflow 在任务有效期内保存场景草拟或反馈任务状态与结果。

## 使用提醒

- 测试时不要说出密码、身份证件号码、住址、医疗隐私或其他敏感信息。
- 永久密钥只允许配置为 Cloudflare Worker Secrets：`ELEVENLABS_API_KEY`、`OPENAI_API_KEY`、`SCENARIO_SIGNING_SECRET`。
