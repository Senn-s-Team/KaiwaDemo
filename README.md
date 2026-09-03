# Kaiwa Demo

面向中文母语、日语约 JLPT N2 学习者的语音会话训练原型。用户可以从固定随机场景开始，也可以用中文描述即将面对的现实场景，由 Worker 生成角色、开场、训练目标和安全边界。对话使用 React、TypeScript、Vite，API 与静态资源部署到同一个 Cloudflare Worker；真实链路使用 ElevenLabs Realtime STT、ElevenLabs WebSocket TTS 和 OpenAI Responses API。

会话采用回合制语音交互。固定随机场景保持五轮；动态场景推荐六至八轮，初始上限十轮，目标尚未覆盖时可在检查点延长至十四轮或二十轮。用户停止录音后必须确认、修改或重录转写，确认前不会请求对话模型。页面只对明确填充音、机械重复和格式噪声做确定性轻整理，同时保留 STT 原文和用户最终稿。

会话结束后首先展示完整对话回顾；反馈模型根据用户最终确认文本生成目标总结、具体优点、语法修正、自然度升级、复用表达和一条重说任务。反馈失败不影响对话回顾。当前对话、转写、计时、反馈和重说结果只保存在页面内存中，不上传长期历史；刷新或关闭标签页会结束当前练习。

## 本地启动

要求：Node.js 20 以上、npm、可用麦克风的现代浏览器。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

在 `.dev.vars` 中配置真实服务后，Vite/Cloudflare 开发服务器会通过同站点 `/api/*` 路由调用 Worker。缺少密钥时页面会明确显示“演示/部分配置”，STT 使用文字输入降级，OpenAI 仅在 `ALLOW_MOCK=true` 时返回标记为 mock 的流程检查回复。Mock 结果不计入端到端验收。

## 本地变量

```dotenv
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
SCENARIO_SIGNING_SECRET=
OPENAI_BASE_URL=https://api.openai.com/v1
ELEVENLABS_VOICE_ID=
ALLOW_MOCK=true
OPENAI_MODEL=gpt-5.6-luna
ELEVENLABS_STT_MODEL=scribe_v2_realtime
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

不要创建任何 `VITE_ELEVENLABS_*` 或 `VITE_OPENAI_*` 变量。`VITE_` 变量会进入浏览器构建产物。

## 检查与构建

```bash
npm run check
npm test
npm run build
npm run preview
```

## Cloudflare Secrets

登录后配置永久密钥：

```bash
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SCENARIO_SIGNING_SECRET
```

`SCENARIO_SIGNING_SECRET` 必须是独立生成的高熵随机值，仅用于签署动态场景和会话令牌，不得与供应商 API Key 复用。

配置非密钥变量，推荐在 Cloudflare Dashboard 的 Worker Settings > Variables 中设置：

- `ELEVENLABS_VOICE_ID`：已在 ElevenLabs 账户中验证日语自然度的 voice ID；
- `OPENAI_BASE_URL=https://api.openai.com/v1`：服务端 OpenAI 兼容 Base URL，也可填写以 `/responses` 结尾的完整端点；
- `OPENAI_MODEL=gpt-5.6-luna`；
- `ELEVENLABS_STT_MODEL=scribe_v2_realtime`；
- `ELEVENLABS_TTS_MODEL=eleven_flash_v2_5`；
- `ALLOW_MOCK=false`。

Demo Key 应使用独立项目、最小权限、较低额度和消费告警，测试结束后可直接撤销。

`OPENAI_BASE_URL` 只由 Worker 读取。它必须是 HTTPS 绝对地址，不能包含用户名、密码、查询参数或 fragment。客户端不能覆盖该地址。自定义网关需要兼容 OpenAI Responses API、Bearer 鉴权和 SSE 事件格式。Azure OpenAI 的 URL、API 版本及鉴权结构不同，需要独立适配。

## Cloudflare Access

如果账户中还有其他公开 Worker，不要启用账户级 **Protect all Workers**。只保护 `kaiwa-demo`：

1. 首次部署前，可在 Zero Trust > Access > Applications 创建 hostname 级 Self-hosted 应用，域名填写 `kaiwa-demo.<workers-dev-subdomain>.workers.dev`；
2. 部署后进入 Workers & Pages > kaiwa-demo > Access，选择 **Protect this Worker behind Access > All traffic**；
3. Allow policy 使用指定邮箱、邮箱一次性验证码或现有可信身份提供商；
4. 确认没有 Bypass Everyone；
5. 未登录浏览器分别访问页面、`/api/config`、`/api/elevenlabs/token`、`/api/scenario/draft`、`/api/session/start`、`/api/respond`、`/api/hint`、`/api/session/checkpoint` 和 `/api/conversation/feedback`，都应先被 Access 阻止；
6. 检查 production、preview、默认 `workers.dev` 和 Custom Domain，避免只保护其中一个入口。

部署命令：

```bash
npm run deploy
```

本 Worker 自身不承载 WebSocket。浏览器在 Access 验证后直接连接 ElevenLabs，并使用 Worker 签发的 15 分钟 single-use token。Cloudflare Access 是页面和 API 的实际身份验证边界；`Sec-Fetch-Site` 检查只减少跨站浏览器请求，不能替代 Access。

## 真机测试清单

- iPhone Safari 在随机盲练模式下完成连续五轮；
- 随机场景队列不会连续重复同一场景；
- 完成页揭示本次场景，且“开发信息”内可查看 JSON 与开发指标；
- 首轮开始前完成麦克风预检；
- 首次麦克风授权、拒绝后恢复、无麦克风提示；
- 手机扬声器，条件允许时再测蓝牙或有线耳机；
- Wi-Fi、切换到移动网络、短暂断网后重试；
- AI 播放时点击录音，确认音频立即停止且只存在一个麦克风会话；
- 录音开始后，确认旧的 TTS 不再继续播放；
- 字幕显示与隐藏均可用，状态切换不影响当前回合；
- 完成后点击“再来一个”，确认进入新的随机练习；
- 完成后选择“重练同场景”，确认仍为刚完成的场景；
- 切到后台再返回，确认页面提示连接已中断并允许重新录制或重新开始；
- 页面刷新、返回、关闭标签页后麦克风指示消失；
- 同一句 AI 台词重播，确认 TTS 请求计数不增加；
- 日期、时间、数字、较长停顿、中文口音、简短相槌、自我修正、中日混合表达；
- 完成后复制 JSON，核对场景字段、每轮时间戳、修改、重录、重播、失败和用量字段。

## 已知限制

- 这是回合制原型，没有实时打断、自动静音结束、发音评分、音素分析或长期历史。
- TTS 使用 WebSocket 获取音频块，但当前实现会收齐本句 MP3 后开始播放，以换取 iPhone Safari 上更稳定的回放与缓存；首个音频块到达时间仍单独记录。
- 无数据库意味着 Worker 只能校验单次请求携带的历史与五轮上限，不能跨请求保存服务端会话计数。Cloudflare Access、供应商额度和低限额 Demo Key 构成额外保护。
- 浏览器切后台、音频输出设备切换或网络切换可能中断实时连接，回到前台后需要重新录制当前回答。
- ElevenLabs 数据保留以当前账户设置和服务条款为准。
- 真机 Safari、真实供应商账户、Cloudflare Access 和最终成本必须人工验证。
