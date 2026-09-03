# 原型数据与隐私边界

- 用户语音会直接发送给 ElevenLabs Realtime Speech-to-Text，用于当前回答的实时转写。
- AI 日语文本会直接发送给 ElevenLabs Text-to-Speech WebSocket，用于生成当前台词语音。
- 用户确认后的转写和有限对话历史会通过同站点 Cloudflare Worker 发送给 OpenAI Responses API，用于生成下一句回复。
- 用户主动请求提示时，当前场景和有限历史会发送给 OpenAI，用于生成回答方向、关键词和参考句。
- 会话结束生成反馈时，STT 原始转写、确定性轻整理稿、用户最终确认稿和完整会话文本会发送给 OpenAI，用于生成文本层面的目标总结与表达建议；系统不据此评价发音、口音、音调或情绪。
- OpenAI 请求设置 `store: false`，不使用 Conversations 持久化。
- 本项目没有数据库，不在自身服务中长期保存对话、反馈或录音。
- 浏览器的 `sessionStorage` 只保存当前标签页的场景随机队列；当前对话、动态场景、转写、计时、反馈和重说结果只存在页面内存中，刷新或关闭标签页后丢失。
- Worker 不记录完整对话、录音、永久 API Key 或临时 token。Cloudflare 与供应商平台自身的安全、诊断和账户日志仍以各自设置为准。
- ElevenLabs 的数据保留能力取决于当前账户、套餐、请求选项和服务条款。本原型不承诺零保留。
- 测试时不要说出密码、身份证件号码、住址、医疗隐私或其他敏感信息。
- 永久密钥只允许配置为 Cloudflare Worker Secrets：`ELEVENLABS_API_KEY`、`OPENAI_API_KEY`、`SCENARIO_SIGNING_SECRET`。
